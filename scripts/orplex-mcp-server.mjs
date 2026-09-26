#!/usr/bin/env node
// orplex-mcp-server.mjs — Expose Orplex to any MCP-speaking agent.
//
// A tiny stdio MCP server (same wire protocol as the client in
// src/lib/mcp-client.ts) that proxies four tools to the local Orplex API:
//
//   spawn_run        — queue a Manager run (isolated worktree, server executor)
//   list_runs        — recent runs with status
//   get_run_review   — lifecycle events + the review patch for one run
//   merge_run        — merge/discard the reviewed branch (final gate stays human)
//
// Register in Claude Code (claude_desktop_config.json / .mcp.json):
//
//   { "mcpServers": { "orplex": { "command": "node",
//       "args": ["<repo>/scripts/orplex-mcp-server.mjs"],
//       "env": { "ORPLEX_URL": "http://localhost:3000",
//                "ORPLEX_MCP_TOKEN": "<same value as the server env>" } } } }
//
// Config: ORPLEX_URL (default http://localhost:3000), ORPLEX_MCP_TOKEN (required).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ORPLEX_URL = (process.env.ORPLEX_URL || "http://localhost:3000").replace(/\/$/, "");
const ORPLEX_TOKEN = process.env.ORPLEX_MCP_TOKEN || "";

if (!ORPLEX_TOKEN) {
  console.error("[orplex-mcp] ORPLEX_MCP_TOKEN is not set — refusing to start");
  process.exit(1);
}

const TOOLS = [
  {
    name: "spawn_run",
    description: "Queue an Orplex server run: isolated git-worktree execution by the Orplex agent. Returns a runId.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task for the Orplex agent" },
        autonomyPolicy: { type: "string", enum: ["approval", "auto"], description: "approval pauses on risky commands; auto never pauses" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_runs",
    description: "List recent Orplex runs with status.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "1-25, default 10" } },
    },
  },
  {
    name: "get_run_review",
    description: "Get one run's lifecycle events and its review patch (unified diff vs base branch).",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
  {
    name: "merge_run",
    description: "Merge or discard the run's reviewed branch. action: merge | discard.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, action: { type: "string", enum: ["merge", "discard"] } },
      required: ["runId", "action"],
    },
  },
];

function callOrplex(tool, params) {
  return fetch(`${ORPLEX_URL}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ORPLEX_TOKEN}` },
    body: JSON.stringify({ tool, ...params }),
    signal: AbortSignal.timeout(120_000),
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`Orplex API ${res.status}: ${text.slice(0, 300)}`);
    return text;
  });
}

// ── Stdio JSON-RPC (MCP) ────────────────────────────────────────────────────

let nextId = 1;
const pending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 110_000);
  });
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message || "MCP error")) : p.resolve(msg.result);
      continue;
    }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "orplex", version: "1.0.0" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params || {};
      callOrplex(name, args || {})
        .then((text) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }))
        .catch((err) =>
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `error: ${err.message}` }], isError: true } }),
        );
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  }
});

process.on("exit", () => process.exit(0));
