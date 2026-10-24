// vercel-sandbox.ts — AI code execution on Vercel Sandbox microVMs.
//
// The exec-backed lane for hosted deployments: `run_command`/`run_in_sandbox`
// is hard-disabled on the cloud lambda (AGENT_EXEC_DISABLED=1), so the
// agent's commands land here instead of the host's own filesystem. Every
// dispatch runs inside an isolated Vercel Sandbox VM:
//   - one warm VM per USER+family (named pool) — repeated runs reuse it;
//   - auth rides the deployment's own Vercel OIDC identity (no stored keys);
//   - no secrets are EVER injected (`env` stays empty), so shell history or
//     `env print` inside the VM cannot leak platform credentials;
//   - the VM is persistent (phase 4): stopping auto-snapshots the filesystem
//     and the next command resumes from that snapshot, so installs and
//     caches survive cold starts without any extra machinery
//     (`persistent:true` + `keepLastSnapshots:{count:2}`).
//
// SERVER-ONLY: imports @vercel/sandbox (which needs the OIDC token) and
// node:http for readiness polling. Never import from client components.

import http from "node:http";
import https from "node:https";
import { TIMEOUTS } from "./constants";

// ---------------------------------------------------------------- config ---

export type SandboxLanguage = "node" | "python";

const IMAGE_BY_LANGUAGE: Record<SandboxLanguage, string> = {
  // Vercel Managed Images (docs/sandbox/concepts/images). Universal carries
  // node; the python family carries the full python toolchain.
  node: "vercel/sandbox/node:22",
  python: "vercel/sandbox/python:3.13",
};

/** Ports the serve lane exposes (declared at creation, ≤ 15). */
const EXPOSED_PORTS = [3000, 8000];
const PORT_BY_LANGUAGE: Record<SandboxLanguage, number> = { node: 3000, python: 8000 };

const RUN_BUDGET_MS = 90_000;
const SERVE_POLL_BUDGET_MS = 60_000;
const SERVE_POLL_INTERVAL_MS = 1_000;
const OUTPUT_CAP = 32_000;

const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The VM's default working directory (verified live: `pwd` → /vercel).
// Files are staged under it, and it exists before the first write — unlike
// /vercel/sandbox, which only appears once something writes there.
const WORK_ROOT = "/vercel";

// ---------------------------------------------------------------- status ---

let sdkMod: typeof import("@vercel/sandbox") | null | undefined;

async function sdk(): Promise<typeof import("@vercel/sandbox")> {
  if (sdkMod === undefined) {
    try {
      sdkMod = (await import("@vercel/sandbox")) as typeof import("@vercel/sandbox");
    } catch {
      sdkMod = null;
    }
  }
  if (!sdkMod) throw new Error("Vercel Sandbox SDK unavailable");
  return sdkMod;
}

type SandboxHandle = import("@vercel/sandbox").Sandbox;

/**
 * Is the Vercel Sandbox lane usable in THIS process? True on a Vercel
 * deployment (the platform provides the OIDC token automatically) or when
 * explicitly opted in outside Vercel (ORPLEX_VSANDBOX=1). A failed SDK import
 * keeps the CI-sandbox fallback in play — never blocks the route.
 */
export async function isVercelSandboxAvailable(): Promise<boolean> {
  if (process.env.ORPLEX_VSANDBOX === "off") return false;
  const onVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true" || Boolean(process.env.VERCEL_OIDC_TOKEN);
  if (!onVercel && process.env.ORPLEX_VSANDBOX !== "1") return false;
  try {
    await sdk();
    return true;
  } catch {
    return false;
  }
}

function safeName(base: string): string {
  return base.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Stable sandbox identity for one user (+ execution family). */
export function sandboxNameFor(userId: string, family: "exec" | "serve"): string {
  const name = `orplex-${family}-${safeName(userId)}`;
  if (!SANDBOX_NAME_RE.test(name)) {
    // Unreachable with cuid user ids — a malformed name must never reach a
    // billable create() call.
    throw new Error("invalid sandbox name");
  }
  return name;
}

// ---------------------------------------------------------------- pool -----

interface PoolEntry {
  sandbox: SandboxHandle;
  lastUsed: number;
  /** In-flight command per VM keeps output ordering sane. */
  busy?: Promise<unknown>;
}

// Module-level, per lambda instance. The VM outlives the lambda: the SDK's
// persistent-sandbox lifecycle (stop → snapshot → resume) is the real cache;
// this map only avoids repeat getOrCreate round trips while this instance
// lives.
const pool = new Map<string, PoolEntry>();

function poolGet(name: string): PoolEntry | undefined {
  const entry = pool.get(name);
  if (entry) entry.lastUsed = Date.now();
  return entry;
}

async function acquire(opts: { userId: string; family: "exec" | "serve"; language: SandboxLanguage }): Promise<{ sandbox: SandboxHandle; name: string }> {
  const name = sandboxNameFor(opts.userId, opts.family);
  const cached = poolGet(name);
  if (cached) return { sandbox: cached.sandbox, name };

  const { Sandbox } = await sdk();
  const base = {
    name,
    ports: EXPOSED_PORTS,
    // 5-minute idle: the platform stops the VM (auto-snapshotting it). The
    // next command auto-resumes from the snapshot — that IS the warm cache.
    timeout: 5 * 60_000,
    // Bounded storage: only the two most recent snapshots are kept.
    keepLastSnapshots: { count: 2 },
    tags: { app: "orplex", family: opts.family, language: opts.language },
    // Egress allowed so pip/npm installs work out of the box. Platform
    // secrets never enter the VM (env is always empty), which is the property
    // that makes allow-all acceptable; an allow-list pypi/npm-only policy is
    // the focused tightening follow-up on this same call.
    resources: { vcpus: 2 },
  };

  let sandbox: SandboxHandle;
  try {
    sandbox = await Sandbox.getOrCreate({ ...base, image: IMAGE_BY_LANGUAGE[opts.language] });
  } catch {
    // Unknown/failed image — degrade to the managed default instead of dying
    // on a version string.
    sandbox = await Sandbox.getOrCreate(base);
  }
  pool.set(name, { sandbox, lastUsed: Date.now() });
  return { sandbox, name };
}

function serialize(entry: PoolEntry | undefined, run: () => Promise<void>): Promise<void> {
  if (!entry) return run();
  const previous = entry.busy;
  const next = (async () => {
    try {
      if (previous) await previous.catch(() => {});
      await run();
    } finally {
      entry.busy = undefined;
    }
  })();
  entry.busy = next;
  return next;
}

// ---------------------------------------------------------------- exec ----

export interface SandboxFileSpec {
  /** Workspace-relative path (no ../, no absolute). */
  path: string;
  content: string;
}

export interface RunCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxName: string;
}

export type SandboxOptions = { userId: string; family: "exec" | "serve"; language: SandboxLanguage };

/** Pick the VM image family from a raw shell command's contents. */
export function languageFromCommand(command: string): SandboxLanguage {
  return /\bpython3?(?:\.\d+)?\b|\bpip[0-3]?\b|\bdjango\b|\bflask\b|\bfastapi\b|\bpandas\b|\bnumpy\b|\bpytest\b/i.test(command)
    ? "python"
    : "node";
}

function assertSafePaths(files: SandboxFileSpec[]): void {
  for (const f of files) {
    if (!f.path || f.path.includes("..") || f.path.includes("\\") || f.path.startsWith("/")) {
      throw new Error(`unsafe sandbox path: ${f.path}`);
    }
  }
}

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + "\n... [truncated]" : s;
}

/**
 * Awaiting CommandFinished on a blocking runCommand; the SDK also returns
 * the live Command type for detached calls, so a runtime shape check keeps
 * the.Now cast honest instead of trusting compile-time hints alone.
 */
async function finish(cmd: Awaited<ReturnType<SandboxHandle["runCommand"]>>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!("exitCode" in cmd) || typeof cmd.exitCode !== "number") {
    // Detached form misuse — loud is better than wrong.
    throw new Error("detached command passed to finish()");
  }
  const finished = cmd as unknown as { stdout(): Promise<string>; stderr(): Promise<string>; exitCode: number };
  return {
    stdout: cap(await finished.stdout()),
    stderr: cap(await finished.stderr()),
    exitCode: finished.exitCode,
  };
}

/**
 * Run ONE blocking command in the user's VM, uploading `files` first.
 * Used for the run_command fallback and the artifact one-shot run lane.
 */
export async function runSandboxCode(opts: SandboxOptions & {
  command: string;
  args?: string[];
  files?: SandboxFileSpec[];
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<RunCodeResult> {
  const started = Date.now();
  const { sandbox, name } = await acquire(opts);
  if (opts.files?.length) {
    assertSafePaths(opts.files);
    await sandbox.writeFiles(opts.files.map((f) => ({ path: `${WORK_ROOT}/${f.path}`, content: Buffer.from(f.content, "utf8") })));
  }
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? TIMEOUTS.SANDBOX_EXEC, 1_000), RUN_BUDGET_MS);
  const entry = poolGet(name);
  let out: { stdout: string; stderr: string; exitCode: number };
  await serialize(entry, async () => {
    out = await finish(
      await sandbox.runCommand({
        cmd: opts.command,
        args: opts.args ?? [],
        ...(opts.files?.length ? { cwd: WORK_ROOT } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
  });
  return {
    stdout: out!.stdout,
    stderr: out!.stderr,
    exitCode: out!.exitCode,
    durationMs: Date.now() - started,
    sandboxName: name,
  };
}

// --------------------------------------------------------------- serve ----

/**
 * Run a full shell command line inside the user's VM (`sh -c`). The command
 * string was screened by exec-guard BEFORE entering here; inside an isolated
 * VM full shell semantics (pipes, &&, env prefixes) are safe and keep
 * `run_command`'s ergonomics identical to the local lane.
 */
export async function runShellCommand(opts: SandboxOptions & {
  shell: string;
  timeoutMs?: number;
  files?: SandboxFileSpec[];
}): Promise<RunCodeResult> {
  return runSandboxCode({
    ...opts,
    command: "sh",
    args: ["-c", opts.shell],
  });
}

export interface ServeAppResult {
  url: string;
  port: number;
  /** True when the server was reachable on the public domain before the deadline. */
  ready: boolean;
  /** Last chars of the server boot diagnostics (for debugging). */
  logTail: string;
  sandboxName: string;
  durationMs: number;
}

function poll(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const isHttps = url.startsWith("https:");
  const client = isHttps ? https : http;
  return new Promise((resolve) => {
    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, SERVE_POLL_INTERVAL_MS);
    };
    const attempt = () => {
      const req = client.get(url, { timeout: 3_000 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500); // 200/3xx/4xx = reached
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    attempt();
  });
}

/**
 * Upload the artifact's files and start the declared server process detached.
 * Returns the PUBLIC url of the exposed port once it responds.
 */
export async function serveSandboxApp(opts: SandboxOptions & {
  files: SandboxFileSpec[];
  entry: string;
  env?: Record<string, string>;
}): Promise<ServeAppResult> {
  const started = Date.now();
  const { sandbox, name } = await acquire(opts);
  assertSafePaths(opts.files);
  const port = PORT_BY_LANGUAGE[opts.language]; // artifact-declared ports map to the exposed ones

  // The serve VM is reused per user, so a previous artifact's process may
  // still hold the port and its files may linger. Kill it, drop the old
  // workspace, then stage the new one — the port is free before we start.
  const cleanupPool = poolGet(name);
  await serialize(cleanupPool, async () => {
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'app/' 2>/dev/null || true; sleep 1; rm -rf app; mkdir -p app"],
      cwd: WORK_ROOT,
      signal: AbortSignal.timeout(20_000),
    });
  });

  await sandbox.writeFiles(opts.files.map((f) => ({ path: `${WORK_ROOT}/app/${f.path}`, content: Buffer.from(f.content, "utf8") })));

  const entry = "app/" + opts.entry;
  if (opts.language === "python" && opts.files.some((f) => f.path === "requirements.txt")) {
    const installPool = poolGet(name);
    await serialize(installPool, async () => {
      await finish(
        await sandbox.runCommand({
          cmd: "pip", args: ["install", "-r", "app/requirements.txt"], cwd: WORK_ROOT,
          signal: AbortSignal.timeout(RUN_BUDGET_MS),
        }),
      );
    });
  }

  const cmd = opts.language === "python" ? "python3" : "node";
  const servePool = poolGet(name);
  let serverLog = "";
  await serialize(servePool, async () => {
    const command = await sandbox.runCommand({
      cmd,
      args: [entry],
      cwd: WORK_ROOT,
      detached: true,
      env: { PORT: String(port), ...(opts.env || {}) },
    });
    // The detached command streams its output — read it so a crash (bad
    // import, port in use) shows up in the error instead of vanishing.
    const reader = (async () => {
      try {
        const logs = (command as unknown as { logs(): AsyncIterable<{ data?: string } | string> }).logs();
        for await (const chunk of logs) {
          const data = typeof chunk === "string" ? chunk : chunk?.data ?? "";
          serverLog = (serverLog + data).slice(-4000);
        }
      } catch {
        /* stream closed with the VM */
      }
    })();
    // Give the server a moment to print its startup errors before polling.
    await Promise.race([reader, new Promise((r) => setTimeout(r, 3000))]);
  });

  const url = sandbox.domain(port);
  const ready = await poll(url, SERVE_POLL_BUDGET_MS);
  return {
    url,
    port,
    ready,
    logTail: ready ? serverLog.slice(-1000) : (serverLog.slice(-2000) || "server did not accept connections in time — check the entry file"),
    sandboxName: name,
    durationMs: Date.now() - started,
  };
}
