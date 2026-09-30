// mcp-client.ts — Minimal MCP (Model Context Protocol) stdio client.
//
// Deliberately implemented against the wire protocol instead of pulling in
// @modelcontextprotocol/sdk (a heavy dependency tree for a solo, low-spec
// machine): MCP stdio transport is newline-delimited JSON-RPC 2.0, which is
// ~150 lines here. Servers are declared in orplex.config.json under
// "mcpServers" — the SAME config shape Claude Code uses, so existing server
// configs work unmodified.
//
// Low-spec budget (8GB laptop):
//   - max 2 server processes at once (extra configured servers are refused
//     with an honest error, not silently dropped)
//   - 120s timeout on every tool call
//   - 5 minutes idle → server process killed (reaped on next use)
//   - processes die with the parent (detached: false)

import { spawn } from "child_process";
import { createHash } from "crypto";

const MAX_SERVERS = 2;
const CALL_TIMEOUT_MS = 120_000;
const IDLE_REAP_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 15_000;

export interface McpToolDef {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Roster name for an MCP tool — the convention Claude Code established. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Parse `mcp__<server>__<tool>` back into parts (null if not an MCP name). */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  // Split at the LAST __ so server names containing single underscores work.
  const last = rest.lastIndexOf("__");
  if (last <= 0 || last === rest.length - 2) return null;
  return { server: rest.slice(0, last), tool: rest.slice(last + 2) };
}

export interface McpServerHandle {
  server: string;
  listTools(): Promise<McpToolDef[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<string>;
  shutdown(): Promise<void>;
}

interface Session {
  handle: McpServerHandle;
  lastUsed: number;
}

const sessions = new Map<string, Session>();

// ── Config ─────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Read `mcpServers` from orplex.config.json (Claude Code config shape). */
export function loadMcpConfig(configDir: string): Record<string, McpServerConfig> {
  try {
    // Lazy fs import keeps this module importable from any bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(configDir, "orplex.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === "object" && typeof (cfg as McpServerConfig).command === "string") {
        out[name] = cfg as McpServerConfig;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioMcpServer implements McpServerHandle {
  server: string;
  private proc: ReturnType<typeof spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private tools: McpToolDef[] | null = null;
  private exited = false;

  /** True while a live child process is attached. */
  get alive(): boolean {
    return !!this.proc && !this.exited;
  }

  constructor(server: string) {
    this.server = server;
  }

  private async ensureProc(cfg: McpServerConfig): Promise<void> {
    if (this.proc && !this.exited) return;
    this.buffer = "";
    this.tools = null;

    const active = [...sessions.values()].filter((s) => s.handle !== this).length;
    if (active >= MAX_SERVERS) {
      throw new Error(`MCP server limit reached (${MAX_SERVERS}) — disable a server in orplex.config.json to add another`);
    }

    // Windows: npx/uvx are .cmd shims — spawn needs a shell to resolve them
    // (bare spawn("npx") dies instantly with ENOENT → EPIPE on first write).
    // Absolute .exe paths skip the shim. On POSIX the direct spawn is right.
    const useShell = process.platform === "win32" && !/\.exe$/i.test(cfg.command);
    const command = useShell ? "cmd" : cfg.command;
    const args = useShell ? ["/d", "/s", "/c", cfg.command, ...(cfg.args ?? [])] : (cfg.args ?? []);

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
      detached: false,
    });
    this.exited = false;

    // Spawn failures (command not found, permission denied) arrive as an
    // 'error' event — unhandled, it would crash the server process.
    this.proc.on("error", () => {
      this.exited = true;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.server}" failed to start (is the command installed and on PATH?)`));
      }
      this.pending.clear();
    });

    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
            else p.resolve(msg.result);
          }
        } catch {
          // Non-JSON line (banner output) — ignore.
        }
      }
    });

    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", () => {
      /* servers log to stderr; swallowed (bounded by OS pipe) */
    });

    this.proc.on("exit", () => {
      this.exited = true;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("MCP server exited unexpectedly"));
      }
      this.pending.clear();
    });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.exited) throw new Error("MCP server not running");
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`MCP write failed: ${err.message}`));
        }
      });
    });
  }

  async listTools(): Promise<McpToolDef[]> {
    if (this.tools) return this.tools;
    const result = (await this.rpc("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    this.tools = (result.tools ?? []).map((t) => ({
      server: this.server,
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema ?? {},
    }));
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc("tools/call", { name: toolName, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result?.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(text || "MCP tool error");
    }
    return (result?.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n")
      .slice(0, 30_000);
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.exited = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP server shut down"));
    }
    this.pending.clear();
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
  }
}

// ── Session management ─────────────────────────────────────────────────────

/** Cached-session accessor. Fails honestly if the server isn't configured. */
export async function getMcpServer(server: string): Promise<McpServerHandle> {
  const cached = sessions.get(server);
  if (cached) {
    if ((cached.handle as unknown as { alive?: boolean }).alive === false) {
      sessions.delete(server);
    } else {
      cached.lastUsed = Date.now();
      return cached.handle;
    }
  }
  const cfg = loadMcpConfig(process.cwd());
  const serverCfg = cfg[server];
  if (!serverCfg) {
    throw new Error(`MCP server "${server}" is not configured in orplex.config.json (mcpServers)`);
  }
  const handle = new StdioMcpServer(server);
  await (handle as unknown as { ensureProc(cfg: McpServerConfig): Promise<void> }).ensureProc(serverCfg);
  sessions.set(server, { handle, lastUsed: Date.now() });
  return handle;
}

// ── Per-run (account) sessions ─────────────────────────────────────────────

/** Sessions for account-connected servers are keyed by resolved config, so
 *  two users connecting the same server name never share a process, while
 *  the same user's identical config across runs IS reused. */
function accountSessionKey(server: string, cfg: McpServerConfig): string {
  return `acct:${server}:${createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 12)}`;
}

/**
 * Session accessor for run-supplied configs (user connectors merged with
 * workspace orplex.config.json). Fails honestly when the server is absent
 * from the supplied map — the executor always passes the run's merged map.
 */
export async function getMcpServerForRun(
  server: string,
  runConfigs: Record<string, McpServerConfig>
): Promise<McpServerHandle> {
  const cfg = runConfigs[server];
  if (!cfg) {
    throw new Error(`MCP server "${server}" is not connected for this account (manage connectors in the app)`);
  }
  const key = accountSessionKey(server, cfg);
  const cached = sessions.get(key);
  if (cached) {
    // A dead session (crashed child / failed probe) must not be reused.
    if ((cached.handle as unknown as { alive?: boolean }).alive === false) {
      sessions.delete(key);
    } else {
      cached.lastUsed = Date.now();
      return cached.handle;
    }
  }
  const handle = new StdioMcpServer(server);
  await (handle as unknown as { ensureProc(cfg: McpServerConfig): Promise<void> }).ensureProc(cfg);
  sessions.set(key, { handle, lastUsed: Date.now() });
  return handle;
}

// ── Idle reaping ───────────────────────────────────────────────────────────

let reapTimer: ReturnType<typeof setInterval> | null = null;

/** Called by the executor loop; reaps sessions idle for IDLE_REAP_MS. */
export function reapIdleMcpSessions(): void {
  const now = Date.now();
  for (const [name, session] of sessions) {
    if (now - session.lastUsed > IDLE_REAP_MS) {
      sessions.delete(name);
      void session.handle.shutdown();
    }
  }
  if (sessions.size === 0 && reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}

/** Start the reaper only while sessions exist (no permanent timer handle). */
export function ensureMcpReaper(): void {
  if (!reapTimer) {
    reapTimer = setInterval(reapIdleMcpSessions, 60_000);
    // Never hold the event loop open just for reaping.
    (reapTimer as unknown as { unref?: () => void }).unref?.();
  }
}

/** Kill everything (executor shutdown / tests). */
export async function shutdownAllMcp(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
  await Promise.all(all.map((s) => s.handle.shutdown()));
}

/** Test seam: forget cached sessions without killing processes. */
export function resetMcpSessionsForTests(): void {
  sessions.clear();
}
