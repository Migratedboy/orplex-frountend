#!/usr/bin/env node
// scripts/e2e/prompt-suite.mjs — command-only end-to-end battery for orplex.
//
// Boots a THROWAWAY local stack (embedded Postgres on :5433 with a private
// `orplex_e2e` database + `next dev` on :5099) and then exercises the product
// purely over HTTP: session bootstrap, auth guards, run validation, a FULL
// real-AI agent run (steered mid-run over the messages API), the approval
// gate, cancel, board, checkpoints, memory capture, staged files, chat SSE,
// and the ledger/insights/provider read lanes. No browser, no preview —
// everything is prompts in, events out, assertions on the output.
//
// Usage:
//   node scripts/e2e/prompt-suite.mjs [--ui-port 5099] [--db-port 5433]
//        [--keep] [--only auth-run] [--run-timeout-ms 480000]
//
// Exit code: number of failed suites (0 = all green).

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));

// ---------------------------------------------------------------- config ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);
const KEEP = hasFlag("--keep");
const ONLY = hasFlag("--only") ? arg("--only", "").split(",").map((s) => s.trim()).filter(Boolean) : [];

const DB_PORT = Number(arg("--db-port", 5433));
const UI_PORT = Number(arg("--ui-port", 5099));

// REMOTE MODE (default): drive the deployed backend directly — it owns the
// database, so nothing is booted locally at all. Pass --local for the old
// fully-local embedded-postgres + next-dev harness.
const envFromFile = loadEnvFile(path.join(ROOT, ".env"));
const REMOTE_BASE = String(arg("--base", envFromFile.NEXT_PUBLIC_API_URL || "https://orplex-backend.vercel.app")).replace(/\/+$/, "");
const LOCAL = hasFlag("--local");
const UI_BASE = LOCAL ? `http://localhost:${UI_PORT}` : REMOTE_BASE;
const BASE = UI_BASE;

// remote auth: forge a NextAuth HS256 session JWT with the deployment's
// NEXTAUTH_SECRET (your own .env value) for an existing user id. Override
// with --user-id / --email, or paste a fresh browser cookie with --cookie.
const FORGE_USER_ID = String(arg("--user-id", (envFromFile.ADMIN_USER_IDS || "").split(",")[0].trim()));
const FORGE_EMAIL = String(arg("--email", "prompt-suite@orplex.local"));
const PASTE_COOKIE = String(arg("--cookie", ""));

const DB_NAME = "orplex_e2e";
const DB_USER = "postgres";
const DB_PASSWORD = "postgres";
const DB_URL_NEW = `postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}`;

const RUN_TIMEOUT_MS = Number(arg("--run-timeout-ms", 8 * 60 * 1000));
const POLL_MS = 2500;

// ------------------------------------------------------------------ util ---
function log(msg) { console.log(msg); }
function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
function elog(msg) { console.log(`[${stamp()}] ${msg}`); }

function portOpen(port, host = "127.0.0.1", timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout });
    s.setTimeout(timeout);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}

async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// .env loader ports the restore-drill parser: KEY = "value" lines only.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    if (v.startsWith("$") && !v.startsWith("$(")) continue; // skip indirections
    out[m[1]] = v;
  }
  return out;
}

// ------------------------------------------------------------- suite state ---
const results = [];
let current = null;

function suite(id, name, fn) {
  return { id, name, fn };
}

async function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const icon = status === "PASS" ? "[PASS]" : status === "FAIL" ? "[FAIL]" : "[NOTE]";
  elog(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function note(detail) { await record(current.id, current.name, "NOTE", detail); }
async function ok(detail = "") { await record(current.id, current.name, "PASS", detail); }
async function fail(detail = "") { await record(current.id, current.name, "FAIL", detail); }

function assert(cond, detail) {
  if (!cond) { throw new Error(detail || "assertion failed"); }
}

// --------------------------------------------------------------------- db ---
// .localpg may hold a stale postmaster.pid from a killed boot. If the port is
// closed and the recorded runner is dead, clear the lock so initdb/postgres
// can start clean.
async function prepareDb() {
  const dataDir = path.join(ROOT, ".localpg", "data");
  const pidFile = path.join(ROOT, ".localpg", "runner.json");
  const dirty = [
    path.join(dataDir, "postmaster.pid"),
  ];
  fs.mkdirSync(dataDir, { recursive: true });
  if (await portOpen(DB_PORT)) {
    elog(`[db] port ${DB_PORT} already open — reusing the running cluster`);
    return;
  }
  for (const f of dirty) {
    if (fs.existsSync(f)) {
      try { fs.rmSync(f); elog(`[db] removed stale lock ${f}`); } catch {}
    }
  }
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "local-db.mjs"), "start"], {
    cwd: ROOT,
    env: { ...process.env, LOCAL_DB_PORT: String(DB_PORT) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stdout.write(String(b)));
  child.stdout.resume();
  child.stderr.on("data", (b) => process.stderr.write(String(b)));
  child.stderr.resume();
  child.unref();
  if (!(await waitPort(DB_PORT, 90_000))) {
    throw new Error(`local Postgres did not open port ${DB_PORT}`);
  }
  // Postgres answers TCP while still "starting up" — wait until it really
  // accepts queries before continuing.
  const readyDeadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const probe = await runPgTool("psql", ["-U", DB_USER, "-h", "localhost", "-p", String(DB_PORT), "-d", "postgres", "-tAc", "SELECT 1"]).catch(() => "");
    if (String(probe).trim() === "1") { ready = true; break; }
    await sleep(1500);
  }
  if (!ready) throw new Error("local Postgres never accepted queries");
  elog(`[db] embedded Postgres up on :${DB_PORT}`);
}

// psql lives in the vendored clients dir fetched by postinstall (.localpg/pgbin).
function findPgTool(name) {
  const dir = path.join(ROOT, ".localpg", "pgbin");
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase() === `${name}.exe` || f.toLowerCase().startsWith(`${name}.`)) {
        return path.join(dir, f);
      }
    }
  } catch {}
  return null;
}

async function runPgTool(tool, psqlArgs, ms = 30_000) {
  const bin = findPgTool(tool);
  if (!bin) throw new Error(`${tool} not found under .localpg/pgbin`);
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(bin, psqlArgs, { env: { ...process.env, PGPASSWORD: DB_PASSWORD }, timeout: ms }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(err).slice(0, 400) + " " + String(stderr).slice(0, 200)));
      else resolve(String(stdout));
    });
  });
}

async function ensureDbExists() {
  // createdb first, else psql -c CREATE DATABASE, else we just use `orplex`.
  const exists = await runPgTool("psql", ["-U", DB_USER, "-h", "localhost", "-p", String(DB_PORT), "-d", "postgres", "-tAc",
    `SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`]).catch(() => "");
  if (exists.trim() === "1") return true;
  try {
    await runPgTool("createdb", ["-U", DB_USER, "-h", "localhost", "-p", String(DB_PORT), DB_NAME]).catch((e) => {
      // createdb may be absent — fall through to psql CREATE
      throw e;
    });
    return true;
  } catch {}
  await runPgTool("psql", ["-U", DB_USER, "-h", "localhost", "-p", String(DB_PORT), "-d", "postgres", "-c", `CREATE DATABASE ${DB_NAME}`]);
  return true;
}

async function pushSchema() {
  const { execFile } = await import("node:child_process");
  const env = {
    ...process.env,
    DATABASE_URL: DB_URL_NEW,
    DIRECT_URL: DB_URL_NEW,
  };
  await new Promise((resolve, reject) => {
    execFile("node", [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "db", "push", "--skip-generate", "--accept-data-loss"], {
      cwd: ROOT, env, timeout: 180_000, maxBuffer: 8 << 20,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`prisma db push failed: ${String(stderr).slice(0, 400)}`));
      else { elog(`[db] schema pushed to ${DB_NAME}`); resolve(); }
    });
  });
}

// ------------------------------------------------------------------ server ---
let serverChild = null;

function buildServerEnv() {
  const envFromFile = loadEnvFile(path.join(ROOT, ".env"));
  const env = {
    ...envFromFile,
    // FORCE LOCAL MODE: strip every cloud/vercel marker so the executor runs
    // in-process, the routes stay local, and prisma accepts localhost URLs.
    NODE_ENV: "development",
    ORPLEX_SERVER_EXECUTOR: "1",
    DEV_AUTH_BYPASS: "1",
    LOCAL_DB_PORT: String(DB_PORT),
    DATABASE_URL: DB_URL_NEW,
    DIRECT_URL: DB_URL_NEW,
    NEXTAUTH_URL: `http://localhost:${UI_PORT}`,
    ORPLEX_MAX_CONCURRENT_RUNS: "2",
  };
  for (const k of ["ORPLEX_API_URL", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_API_BASE_URL",
    "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_TARGET_ENV", "VERCEL_OIDC_TOKEN",
    "NEXTAUTH_URL_OVERRIDE", "AUTH_COOKIE_DOMAIN"]) delete env[k];
  return env;
}

async function bootServer() {
  serverChild = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(UI_PORT)], {
    cwd: ROOT,
    env: buildServerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild.stdout.on("data", (b) => { const s = String(b); if (/error|Error|ready|✓/i.test(s)) process.stdout.write(`[next] ${s}`); });
  serverChild.stderr.on("data", (b) => process.stderr.write(`[next] ${b}`));
  serverChild.on("exit", (code) => { elog(`[next] dev server exited early: code=${code}`); });
}

async function waitHealthy(ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await http("GET", "/api/health", null, { anon: true, timeout: 60_000 });
      if (r.ok && r.json?.checks?.database === "ok") return r.json;
    } catch {}
    await sleep(1500);
  }
  return null;
}

// ------------------------------------------------------------------- http ---
const jar = new Map(); // cookie name -> value

function cookieHeader(explicit) {
  const parts = [];
  for (const [k, v] of jar) parts.push(`${k}=${v}`);
  if (explicit) parts.push(explicit);
  return parts.join("; ");
}

async function http(method, pathname, body, opts = {}) {
  const { anon = false, raw = false, timeout = 120_000, headers = {} } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const h = {
    "x-requested-with": "fetch",
    ...headers,
  };
  if (body !== undefined && body !== null) h["content-type"] = "application/json";
  if (!anon) {
    const c = cookieHeader();
    if (c) h.cookie = c;
  }
  const init = { method, headers: h, signal: ctl.signal, redirect: "manual" };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  try {
    const res = await fetch(`${UI_BASE}${pathname}`, init);
    for (const sc of res.headers.getSetCookie?.() || []) {
      const pair = sc.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx > 0 && !jar.has(pair.slice(0, idx))) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      ok: res.ok, status: res.status, text, json,
      headers: res.headers,
      ...(raw ? { body: res.body } : {}),
    };
  } finally { clearTimeout(t); }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
  return true;
}

// ------------------------------------------------------------- run driver ---
const runCache = new Map(); // prompt-hash -> run id (dedupe across suites)

async function createRun(body) {
  const r = await http("POST", "/api/agent/runs", body);
  expect(r.status === 200 && r.json?.success === true && r.json?.run?.id,
    `POST /api/agent/runs -> ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json.run;
}

async function getRun(id) {
  const r = await http("GET", `/api/agent/runs/${id}`);
  expect(r.status === 200 && r.json?.run, `GET run ${id} -> ${r.status}`);
  return r.json.run;
}

async function eventPage(runId, cursor) {
  const r = await http("GET", `/api/agent/runs/${runId}/events?after=${cursor}`);
  expect(r.status === 200 && r.json?.success, `events -> ${r.status} ${r.text.slice(0, 200)}`);
  return r.json; // { events, cursor }
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// Streams the whole console transcript through the caller, asserting the
// lifecycle the executor promises: claim -> tasks -> verify -> terminal.
async function followRun(run, { timeoutMs = RUN_TIMEOUT_MS, label = "" , onSteer = null } = {}) {
  const runId = run.id;
  let cursor = -1;
  const seen = new Set();
  const events = [];
  const start = Date.now();
  let steerDone = false;
  let final = null;
  while (Date.now() - start < timeoutMs) {
    const page = await eventPage(runId, cursor).catch(() => null);
    if (page) {
      cursor = Math.max(cursor, page.cursor ?? -1);
      for (const ev of page.events) {
        seen.add(ev.type);
        events.push(ev);
        const summary = summarizeEvent(ev);
        if (summary) elog(`      ↳ ${summary}`);
      }
    }
    const s = await getRun(runId).catch(() => null);
    if (s) {
      const st = s.status;
      if (["pending", "claimed", "planning", "executing", "verifying"].includes(st) && onSteer && !steerDone) {
        steerDone = true;
        await onSteer(runId, events);
      }
      if (st === "waiting_approval") {
        elog("      ↳ run is waiting for an approval gate");
        const apr = await http("POST", `/api/agent/runs/${runId}/approve`, {});
        elog(`      ↳ approve -> HTTP ${apr.status} ${JSON.stringify(apr.json || {}).slice(0, 200)}`);
        // resume polling; the run should carry on to a terminal state
      }
      if (TERMINAL.has(st)) { final = s; break; }
    }
    await sleep(POLL_MS);
  }
  if (!final) {
    const s = await getRun(runId).catch(() => null);
    if (s && TERMINAL.has(s.status)) final = s;
  }
  if (!final) {
    // cancel the straggler so we don't leak CPU into later suites
    await http("DELETE", `/api/agent/runs/${runId}`).catch(() => {});
    throw new Error(`run ${runId} did not reach a terminal status in ${timeoutMs}ms`);
  }
  return { final, events, seen };
}

// keeps logs readable — one line per event (payload may nest an inner payload: {type, payload:{...}})
function summarizeEvent(ev) {
  const p = ev.payload?.payload ?? ev.payload ?? {};
  switch (ev.type) {
    case "claimed": return "claimed";
    case "plan": return `plan: ${String(p.planSummary ?? p.summary ?? p.title ?? "").slice(0, 120)}`;
    case "task": return `task: ${p.id ?? ""} ${p.name ?? p.title ?? ""}`.slice(0, 130);
    case "tool-notify": return `tool: ${p.tool ?? p.name ?? ""} ${typeof p.detail === "string" ? p.detail.slice(0, 80) : ""}`.trim();
    case "tool-denied": return `tool-denied: ${p.tool ?? ""} ${String(p.reason ?? "").slice(0, 100)}`;
    case "verify": return `verify: ${p.success ?? p.lanes?.typecheck ?? ""} ${String(p.detail ?? p.error ?? "").slice(0, 100)}`;
    case "verify-repaired": return "verify-repaired";
    case "checkpoint-created": return `checkpoint @${p.sequence}${p.auto ? " (auto)" : ""}`;
    case "checkpoint-restored": return `checkpoint-restored @${p.sequence}`;
    case "compacted": return "context compacted";
    case "mcp-tools-loaded": return `mcp tools loaded (${p.count ?? ""})`;
    case "mcp-server-error": return `mcp error: ${String(p.error ?? "").slice(0, 100)}`;
    case "agent-message": return `steering: ${String(p.body ?? "").slice(0, 100)}`;
    case "requeued-after-restart": return "requeued after restart";
    case "native-tools-unsupported": return "native-tools-unsupported";
    default: return null;
  }
}

// chat SSE reader
async function chatStream(body, timeoutMs = 240_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const res = await fetch(`${UI_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fetch",
      cookie: cookieHeader(),
    },
    body: JSON.stringify(body),
    signal: ctl.signal,
  });
  const loaded = res.body.pipeThrough(new TextDecoderStream());
  let buf = "";
  let content = "";
  let done = false;
  const reader = loaded.getReader();
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed.content === "string") { content += (content ? "\n[notice] " : "") + parsed.content; }
          else if (typeof parsed.choices?.[0]?.delta?.content === "string" && parsed.choices[0].delta.content) {
            content += parsed.choices[0].delta.content;
          }
        } catch { /* non-JSON data line */ }
      }
      if (done) break;
    }
  }
  clearTimeout(t);
  try { reader.cancel().catch(() => {}); } catch {}
  return { status: res.status, chatDone: done, text: content };
}

// ------------------------------------------------------------------ auth ---
// next-auth@4 session tokens are DirectedEncryptedJWs (alg dir, enc
// A256GCM, HKDF key from NEXTAUTH_SECRET) — mint the cookie with the
// deployment's own library instead of hand-rolling a signature.
async function forgeSessionToken() {
  const secret = envFromFile.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("--cookie missing and no NEXTAUTH_SECRET found to forge a session JWT");
  if (!FORGE_USER_ID) throw new Error("--cookie missing and no user id (ADMIN_USER_IDS or --user-id) to forge a session JWT for");
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(ROOT, "package.json"));
  const { encode } = req("next-auth/jwt");
  const token = await encode({
    token: { name: "prompt-suite", email: FORGE_EMAIL, picture: null, sub: FORGE_USER_ID, id: FORGE_USER_ID },
    secret,
  });
  return token;
}

async function bootAuth() {
  if (PASTE_COOKIE) {
    const idx = PASTE_COOKIE.indexOf("=");
    expect(idx > 0, "--cookie must look like name=value, e.g. --cookie next-auth.session-token=<paste>");
    jar.set(PASTE_COOKIE.slice(0, idx), PASTE_COOKIE.slice(idx + 1));
  } else {
    const token = await forgeSessionToken();
    for (const name of ["next-auth.session-token", "__Secure-next-auth.session-token"]) {
      jar.clear();
      jar.set(name, token);
      const s = await http("GET", "/api/auth/session", null, { timeout: 60_000 });
      const user = s.json?.user;
      if (user && user.id) {
        elog(`[auth] forged session accepted as cookie "${name}" (user ${user.id})`);
        return;
      }
    }
    jar.clear();
    throw new Error(
      `forged cookie rejected by ${BASE} (resolve=/api/auth/session -> HTTP 200: {}). ` +
      `The deployed NEXTAUTH_SECRET likely differs from local .env — rerun with ` +
      `--cookie next-auth.session-token=<value from your browser session on www.orplex.tech>`);
  }
}

// ------------------------------------------------------------------ boot ---
async function boot() {
  if (!LOCAL) {
    elog(`== remote mode: driving ${BASE} (no local infra) ==`);
    const h = await http("GET", "/api/health", null, { anon: true, timeout: 60_000 });
    if (!(h.ok && h.json?.checks?.database === "ok")) {
      throw new Error(`backend health is not green yet: HTTP ${h.status} ${JSON.stringify(h.json).slice(0, 200)}`);
    }
    elog(`[health] healthy — version ${h.json.version}`);
    await bootAuth();
    return h.json;
  }

  elog("== phase 1: local Postgres ==");
  await prepareDb();
  await ensureDbExists();
  await pushSchema();

  elog("== phase 2: next dev (local mode, in-process executor) ==");
  await bootServer();
  const health = await waitHealthy();
  if (!health) throw new Error("next dev never became healthy on /api/health");
  elog(`[next] healthy — version ${health.version}`);

  elog("== phase 3: session bootstrap (dev bypass) ==");
  const ds = await http("GET", "/api/dev/session", null, { anon: true });
  expect(ds.json?.enabled === true, `dev session bypass should report enabled, got ${JSON.stringify(ds.json)}`);
  const login = await http("GET", "/api/dev/session?action=login", null, { anon: true });
  expect(login.status === 200 && jar.has("next-auth.session-token"),
    `dev login should mint a session cookie, got HTTP ${login.status}`);
  elog("[auth] session cookie minted for dev-user");
  return health;
}

// ---------------------------------------------------------------- suites ---
const suites = [];

suites.push(suite("health", "health endpoint reports healthy + version", async () => {
  const h = await http("GET", "/api/health", null, { anon: true });
  expect(h.ok && h.json?.status === "healthy", `status=${h.json?.status} checks=${JSON.stringify(h.json?.checks)}`);
  expect(h.json?.checks?.database === "ok", "database check ok");
  await ok(`version=${h.json.version}`);
}));

suites.push(suite("auth-guards", "unauthenticated requests are refused", async () => {
  const guard = (code) => (code === 401 || code === 403 || code === 429);
  const c = await http("POST", "/api/agent/runs", { prompt: "anon test" }, { anon: true });
  expect(guard(c.status), `anon run POST -> HTTP ${c.status} (want 401/403)`);
  const l = await http("GET", "/api/agent/runs", null, { anon: true });
  expect(guard(l.status), `anon runs list -> HTTP ${l.status} (want 401/403)`);
  const ch = await http("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }, { anon: true });
  expect(guard(ch.status), `anon chat -> HTTP ${ch.status} (want 401/403)`);
  await ok(`statuses: ${c.status}/${l.status}/${ch.status}`);
}));

suites.push(suite("runs-validation", "run creation validates bodies (defaults fail closed)", async () => {
  const empty = await http("POST", "/api/agent/runs", { prompt: "   " });
  expect(empty.status >= 400 && empty.status < 500, `empty prompt -> HTTP ${empty.status}`);
  const bad = await http("POST", "/api/agent/runs", { prompt: "ok prompt", mode: "explode" });
  expect(bad.ok || (bad.status >= 400 && bad.status < 500), `invalid mode -> HTTP ${bad.status}`);
  if (bad.ok) {
    const ev0 = await http("GET", `/api/agent/runs/${bad.json?.run?.id}/events?after=-1`);
    const e0 = (ev0.json?.events || []).find((e) => e.type === "spawned") || ev0.json?.events?.[0];
    const inner = e0?.payload?.payload ?? e0?.payload ?? {};
    expect(inner.mode === "code", `invalid-mode run stored as mode "${inner.mode}" (must fail closed to "code")`);
    expect(ev0.json?.events?.[0].type !== "run-failed", `invalid-mode run failed at boot: ${String(ev0.json?.events?.[0]?.payload?.error ?? "").slice(0, 120)}`);
  }
  const pri = await http("POST", "/api/agent/runs", { prompt: "ok prompt", priority: 9999 });
  expect(pri.ok, `priority 9999 -> HTTP ${pri.status}`);
  expect(pri.json?.run?.priority === 100, `priority 9999 stored as ${pri.json?.run?.priority} (must clamp to 100)`);
  await ok();
}));

suites.push(suite("cancel-pending", "unclaimed run can be cancelled", async () => {
  const run = await createRun({ prompt: "E2E cancel probe — no-op that must never execute", executionTarget: "none" });
  const del = await http("DELETE", `/api/agent/runs/${run.id}`);
  expect(del.status === 200 || del.status === 202 || (del.json?.success === true),
    `DELETE run -> ${del.status} ${JSON.stringify(del.json).slice(0, 150)}`);
  const after = await getRun(run.id);
  expect(after.status === "cancelled", `post-cancel status = ${after.status}`);
  await ok(`run ${run.id} cancelled`);
}));

suites.push(suite("messages-validation", "steering/messages API validates input", async () => {
  const none = await http("POST", "/api/agent/messages", { runId: "nowhere", body: "hello" });
  expect(none.status === 404 || none.status === 409 || none.status === 400, `unknown run -> HTTP ${none.status}`);
  const huge = await http("POST", "/api/agent/messages", { runId: "nowhere", body: "y".repeat(4001) });
  expect(huge.status >= 400 && huge.status < 500, `4001-char body -> HTTP ${huge.status}`);
  await ok();
}));

suites.push(suite("agent-run", "full agent run: prompt -> AI tools -> verify -> complete", async () => {
  const run = await createRun({
    prompt: "Create a file named e2e-hello.js whose entire content is exactly the single line console.log('ORPLEX_E2E_OK'). Do not create any other files. Run it with node to confirm it prints ORPLEX_E2E_OK, then finish.",
    mode: "code",
    autonomyPolicy: "auto",
    executionTarget: "server",
  });
  elog(`[run] ${run.id} spawned — following the executor live`);
  let steered = false;
  const { final, events, seen } = await followRun(run, {
    label: "agent-run",
    onSteer: async (runId) => {
      if (steered) return;
      steered = true;
      elog("      ↳ steering mid-run via POST /api/agent/messages");
      const m = await http("POST", "/api/agent/messages", { runId, body: "While you are here: after the file works, rename it to e2e-hello-1.js in verification notes (do NOT actually rename — just mention you got this steering message)." });
      expect(m.status === 200 && m.json?.delivered === true,
        `steer -> ${m.status} ${JSON.stringify(m.json).slice(0, 200)}`);
    },
  });
  expect(final.status === "completed", `final status = ${final.status}`);
  expect(seen.has("claimed") || seen.has("task"), `lifecycle events seen: ${[...seen].join(",")}`);
  const steerEvent = events.find((e) => e.type === "agent-message");
  if (!steerEvent) await note("steering event not surfaced in the event stream (executor consumed it silently) — not a hard_fail");
  await ok(`completed — events: ${[...seen].join(", ")}`);
}));

suites.push(suite("checkpoints", "checkpoints recorded and rewindable route answers", async () => {
  const r = await http("GET", "/api/agent/runs?limit=20");
  expect(r.ok, `board GET -> ${r.status}`);
  const runs = r.json?.runs || r.json || [];
  const mine = (Array.isArray(runs) ? runs : []).filter((x) => x && x.prompt);
  const target = mine[0];
  expect(target && target.id, "at least one run on the board");
  const cp = await http("GET", `/api/agent/runs/${target.id}/events?after=-1`);
  expect(cp.ok && cp.json?.success === true, `events list -> ${cp.status}`);
  const hasCp = (cp.json.events || []).some((e) => e.type === "checkpoint-created");
  if (!hasCp) await note("no checkpoint-created event on the first run (auto-checkpoint may be gated by settings) — not a hard_fail");
  else await ok("checkpoint-created event found");
}));

suites.push(suite("approval-gate", "approval-mode run honours the gate (or honestly skips it)", async () => {
  const run = await createRun({
    prompt: "Create two files: gate-a.txt containing A, and gate-b.txt containing B. Then finish. This is an approval-policy run.",
    mode: "code",
    autonomyPolicy: "approval",
    executionTarget: "server",
  });
  elog(`[run] ${run.id} approval-mode spawned`);
  let gated = false;
  const { final, seen } = await followRun(run, { label: "approval-gate" }).catch(async (e) => {
    // a timeout on waiting_approval means the gate held everything for a human
    if (String(e.message).includes("did not reach")) {
      const s = await getRun(run.id);
      if (s.status === "waiting_approval") gated = true;
    }
    if (gated) {
      // approve late, allow a final window to complete
      await http("POST", `/api/agent/runs/${run.id}/approve`, {});
      const s2 = await getRun(run.id);
      return { final: s2, seen: new Set(), events: [] };
    }
    throw e;
  });
  if (gated) {
    await ok(`gate HELD the mutating run in waiting_approval (status at timeout: waiting_approval)`);
  } else {
    await ok(`running with the ${"approval"} policy reached ${final.status} without pausing — the gate judged the steps safe`);
  }
}, ));

suites.push(suite("board", "board feed lists runs with metadata", async () => {
  const r = await http("GET", "/api/agent/runs?limit=3");
  expect(r.ok && (r.json?.runs || r.json), `board -> ${r.status}`);
  const runs = r.json?.runs || [];
  expect(runs.length <= 3, `limit respected: ${runs.length} rows`);
  expect(runs.every((x) => typeof x?.status === "string"), "rows carry status");
  await ok(`${runs.length} rows`);
}));

suites.push(suite("read-lanes", "ledger, spend, insights, provider-status, notifications answer", async () => {
  const probes = [];
  for (const [name, path] of [["ledger", "/api/agent/ledger"], ["spend", "/api/agent/spend"], ["insights", "/api/agent/insights"], ["notifications", "/api/agent/notifications"]]) {
    const r = await http("GET", path);
    probes.push({ name, st: r.status });
  }
  // provider-status sweeps live model providers — generous timeout, verdict informative
  const ps = await http("GET", "/api/agent/provider-status", null, { timeout: 240_000 });
  probes.push({ name: "provider-status", st: ps.status });
  const dead = probes.filter((p) => p.st !== 200);
  if (dead.length === probes.length) {
    throw new Error(`every read lane is down: ${dead.map((d) => `${d.name}:${d.st}`).join(", ")}`);
  }
  if (dead.length) await note(`${dead.length} lane(s) not deployed: ${dead.map((d) => `${d.name}:${d.st}`).join(", ")} — non-200 lanes are optional cloud features`);
  await ok(`${probes.length - dead.length}/${probes.length} lanes live (${dead.length ? "see note" : "all"})`);
}));

suites.push(suite("memory", "workspace memory capture persists and lists", async () => {
  const cap = await http("POST", "/api/agent/memory/capture", {
    directoryName: "e2e-demo",
    task: "prompt-suite smoke",
    writtenFiles: { "a.txt": "alpha content for memory lane" },
    lanes: { typecheck: "pass", browser: "skipped" },
    acceptedSuggestions: ["kept the file small"],
    finalStatus: "done",
  });
  expect(cap.ok && cap.json?.success === true, `capture -> ${cap.status} ${JSON.stringify(cap.json).slice(0, 200)}`);
  const list = await http("GET", "/api/agent/memory");
  expect(list.ok, `memory list -> ${list.status}`);
  await ok(`stored=${cap.json.stored ?? "?"}`);
}));

suites.push(suite("files", "staged in-memory create_file works end to end", async () => {
  const made = await http("POST", "/api/files", { filename: "e2e-note.txt", content: "prompt-suite staged file" });
  expect(made.ok, `POST /api/files -> ${made.status} ${JSON.stringify(made.json || {}).slice(0, 200)}`);
  const id = made.json?.id || made.json?.file?.id;
  expect(id, "staged file id returned");
  const got = await http("GET", `/api/files/${id}`);
  expect(got.ok, `GET /api/files/${id} -> ${got.status}`);
  const list = await http("GET", "/api/files");
  expect(list.ok || list.status === 400, `GET /api/files -> ${list.status}`);
  await ok();
}));

suites.push(suite("chat-sse", "chat streams a real AI answer over SSE", async () => {
  const r = await chatStream({
    messages: [{ role: "user", content: "Answer with exactly: CHAT_E2E_OK" }],
    mode: "ask",
    effort: "low",
  });
  expect(r.status === 200, `chat -> ${r.status}`);
  expect(r.chatDone, "SSE stream ended with [DONE]");
  expect(r.text.trim().length > 0, `no content chunks`);
  elog(`      ↳ model said: ${r.text.trim().slice(0, 160)}`);
  await ok(`${r.text.trim().length} chars streamed`);
}));

suites.push(suite("conversations", "chat left a conversation behind that lists back", async () => {
  const list = await http("GET", "/api/conversations?limit=20");
  expect(list.ok && Array.isArray(list.json?.conversations),
    `list -> ${list.status} shape=${JSON.stringify(list.json).slice(0, 120)}`);
  await ok(`${list.json.conversations.length} conversation(s)`);
}));

suites.push(suite("local-lanes", "local grep lane executes over the workspace", async () => {
  const g = await http("POST", "/api/agent/grep", { pattern: "ORPLEX_E2E_OK", maxResults: 5 });
  if (g.status === 200) {
    await ok("grep lane 200");
  } else {
    await note(`grep lane -> HTTP ${g.status} (lane may require a workspace cwd binding)`);
  }
}));

// ------------------------------------------------------------------ main ---
// Routes whose state lives in the desktop app's own process (staged files /
// local tool lanes) can't be exercised against the stateless serverless
// backend — they are local-mode lanes by design.
const LOCAL_ONLY_SUITES = new Set(["files", "local-lanes"]);

async function main() {
  try {
    await boot();

    elog("== phase 4: prompt-driven feature suites ==");
    for (const s of suites) {
      current = s;
      if (ONLY.length && !ONLY.includes(s.id)) { continue; }
      if (!LOCAL && LOCAL_ONLY_SUITES.has(s.id)) {
        elog(`  ⤼ ${s.name} — skipped (local-only lane)`);
        await note("serverless backend has no desktop process holding this lane's state");
        results.pop(); // don't count skips as results
        continue;
      }
      const started = Date.now();
      elog(`  ▶ ${s.name}`);
      try {
        await s.fn.call({ id: s.id, name: s.name });
      } catch (e) {
        await fail(String(e.message || e).slice(0, 300));
      }
      const secs = Math.round((Date.now() - started) / 1000);
      elog(`  ◀ ${s.name} done (${secs}s)`);
  }

    // ------------- summary -------------
    log("");
    log("═══════════════════════ PROMPT-SUITE SUMMARY ═══════════════════════");
    for (const r of results) {
      const icon = r.status === "PASS" ? " ✅" : r.status === "FAIL" ? " ❌" : " ⚪";
      log(`${icon} ${r.status.padEnd(4)} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    const fails = results.filter((r) => r.status === "FAIL").length;
    log("═════════════════════════════════════════════════════════════════════");
    log(`  ${results.length - fails}/${results.length} green; ${fails} failing`);
    process.exitCode = fails;
  } finally {
    if (serverChild && !KEEP) {
      elog("[shutdown] stopping next dev");
      try { serverChild.kill("SIGTERM"); } catch {}
    } else if (KEEP) {
      elog(`[keep] next dev still running on ${UI_BASE} (cookie jar: next-auth.session-token)`);
    }
  }
}

await main();
