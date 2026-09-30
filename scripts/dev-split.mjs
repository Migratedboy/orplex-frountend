#!/usr/bin/env node
// dev-split.mjs — run the split apps side by side for development.
//
//   node scripts/dev-split.mjs
//
// UI  → next dev on :5000 (repo root, UI-only)
// API → next dev on :5010 (backend/, API-only)
//
// ORPLEX_API_URL=https://api.example.com node scripts/dev-split.mjs
//   → cloud mode: only the UI spawns; the UI talks to the hosted backend.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const backendDir = path.join(root, "backend");
const apiBase = process.env.ORPLEX_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || `http://localhost:${process.env.ORPLEX_API_PORT || 5010}`;
const cloudMode = /^https?:\/\//.test(apiBase) && !apiBase.includes("localhost") && !apiBase.includes("127.0.0.1");

if (!cloudMode && !existsSync(backendDir)) {
  console.error("[split] backend/ not found — run from the repo root.");
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function shutdown() {
  if ( shuttingDown ) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

function runNext(label, cwd, port, extraEnv = {}) {
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\n[split] ${label} exited (code ${code ?? "?"}) — shutting down both apps.`);
      shutdown();
    }
  });
  children.push(child);
  return child;
}

// Cloud mode: UI only — it talks to the hosted backend via the env var.
runNext("ui", root, process.env.ORPLEX_PORT || 5000, {
  NEXT_PUBLIC_API_BASE_URL: apiBase,
});
if (!cloudMode) {
  runNext("api", backendDir, process.env.ORPLEX_API_PORT || 5010);
}

console.log(`[split] UI  → http://localhost:${process.env.ORPLEX_PORT || 5000}`);
if (!cloudMode) console.log(`[split] API → http://localhost:${process.env.ORPLEX_API_PORT || 5010}`);
else console.log(`[split] API → ${apiBase} (cloud mode — no local API)`);
