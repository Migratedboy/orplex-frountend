#!/usr/bin/env node
// agent-ci-run.mjs — The headless agent CI surface.
//
// Boots the Orplex server executor against a throwaway database and runs a
// fixed task battery through the REAL tool loop — the same lease → worktree →
// tool-call → verify → commit machinery the desktop app uses, with the model
// replaced by a deterministic fixture (AI_PROVIDER=ci-fixture). Every task
// must end with a HARD verdict: `tsc --noEmit` exit 0 AND `jest` exit 0 run
// against the files the loop actually produced. An LLM saying "looks done"
// never counts; an empty EXIT line never counts.
//
// What is genuinely under test here (not mocked): the lease/CAS arbitration,
// native tool dispatch (write_file/edit_file/read_file/run_command), the
// exec-guard screening, worktree isolation + commit, artifact emission, and
// the runner's hard-verdict gate over the produced output.
//
// Usage:
//   node scripts/agent-ci-run.mjs [--keep] [--task name] [--list]
//
//   --keep     keep the scratch workspace + DB for debugging (default: clean)
//   --task X   run one battery task by name
//   --list     print the battery and exit
//
// Exit codes: 0 = every task PASSED its hard verdict; 1 = any FAIL or infra
// error. CI reads only the exit code; the human reads the printed verdicts.
//
// Deterministic gates (no self-grading): before the battery is allowed to
// run, the repo itself must pass tsc + jest + eslint — judged ONLY by their
// exit codes. The battery never accepts "the agent said it's done"; the
// machine's compilers, tests, and linters are the only graders.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const listOnly = args.includes("--list");
const SKIP_GATES = args.includes("--skip-gates"); // local iteration only — CI never passes this
const taskIdx = args.indexOf("--task");
const onlyTask = taskIdx >= 0 ? args[taskIdx + 1] : null;

// ── Throwaway Postgres on a private port (embedded-postgres, like the app) ─
const PG_PORT = 5539 + (process.pid % 64); // collide-free-ish for parallel runs
const PG_USER = "ci_agent";
const PG_PASS = "ci_agent_pw";
const DB_NAME = "ci_agent_db";

// ── Fixed battery ──────────────────────────────────────────────────────────
// Three task archetypes, mirroring what real users ask for. Each entry:
//   fixture  — the deterministic model script (JSON turns for ci-fixture)
//   verify   — shell chain whose EXIT CODE is the hard verdict on the output
const BATTERY = [
  {
    name: "greenfield-page",
    prompt:
      "Create a landing page for a coffee shop called 'Bean There'. Use index.html + styles.css only.",
    fixture: [
      {
        toolCalls: [
          {
            name: "write_file",
            args: {
              path: "index.html",
              content:
                "<!doctype html>\n<html>\n<head><title>Bean There</title><link rel=\"stylesheet\" href=\"styles.css\"></head>\n<body>\n  <h1>Bean There</h1>\n  <p id=\"tagline\">Coffee, brewed with intent.</p>\n</body>\n</html>\n",
            },
          },
          {
            name: "write_file",
            args: {
              path: "styles.css",
              content: "body { font-family: sans-serif; background: #f5efe6; }\nh1 { color: #4b2e2b; }\n",
            },
          },
        ],
      },
      { text: "Landing page written: index.html + styles.css." },
    ],
    verify: `node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const c=fs.readFileSync('styles.css','utf8');if(!/Bean There/.test(h))process.exit(3);if(!c.includes('#4b2e2b'))process.exit(4);console.log('verdict: files present and styled')`,
  },
  {
    name: "refactor-function",
    prompt:
      "In src/math.js there is add(a,b). Add a multiply(a,b) export and use it nowhere else. Keep add unchanged.",
    fixture: [
      {
        toolCalls: [
          {
            name: "read_file",
            args: { path: "src/math.js" },
          },
          {
            name: "edit_file",
            args: {
              path: "src/math.js",
              old_text: "function add(a, b) { return a + b; }",
              new_text:
                "function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }",
            },
          },
          {
            name: "edit_file",
            args: {
              path: "src/math.js",
              old_text: "module.exports = { add };",
              new_text: "module.exports = { add, multiply };",
            },
          },
        ],
      },
      { text: "Added multiply() alongside add()." },
    ],
    verify: `node -e "const {add,multiply}=require('./src/math.js');if(add(2,3)!==5)process.exit(3);if(multiply(4,5)!==20)process.exit(4);console.log('verdict: add intact, multiply correct')`,
  },
  {
    name: "test-driven-fix",
    prompt:
      "util.js's slugify must also strip emoji. tests/util.test.js already covers it. Make it pass.",
    fixture: [
      {
        toolCalls: [
          {
            name: "edit_file",
            args: {
              path: "util.js",
              old_text: "return s.toLowerCase().trim();",
              new_text: "return s.replace(/[^\\p{L}\\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();",
            },
          },
          { name: "run_command", args: { command: "node --test tests/" } },
        ],
      },
      { text: "slugify now strips emoji; node --test passes." },
    ],
    verify: `node --test tests/`,
  },
];

if (listOnly) {
  for (const t of BATTERY) console.log(`${t.name}\t${t.prompt}`);
  process.exit(0);
}

const tasks = onlyTask ? BATTERY.filter((t) => t.name === onlyTask) : BATTERY;
if (tasks.length === 0) {
  console.error(`Unknown task "${onlyTask}". Use --list to see the battery.`);
  process.exit(1);
}

// ── Small helpers ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg) {
  console.log(`[agent-ci] ${msg}`);
}
async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1", timeout: 800 }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("timeout", () => { s.destroy(); resolve(false); });
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
/** Tokenize a simple argv string (double quotes supported; no shell syntax). */
function tokenize(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/(?:"([^"]*)"|(\S+))/g)) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * Run an argv command, capture exit code; output passes through for humans.
 * No shell: argv-array spawn, Windows npx resolves to npx.cmd explicitly.
 */
function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    let argv = tokenize(cmd);
    if (process.platform === "win32" && (argv[0] === "npx" || argv[0] === "npm")) {
      argv[0] = `${argv[0]}.cmd`;
    }
    const p = spawn(argv[0], argv.slice(1), { shell: false, stdio: opts.quiet ? "ignore" : "inherit", cwd: opts.cwd || ROOT });
    p.on("error", () => resolve(1));
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

// ── 1. Boot the throwaway database ─────────────────────────────────────────
log(`booting throwaway postgres on :${PG_PORT}`);
const { default: EmbeddedPostgres } = require("embedded-postgres");
const pg = new EmbeddedPostgres({
  databaseDir: path.join(ROOT, ".ci-agent-pg"),
  user: PG_USER,
  password: PG_PASS,
  port: PG_PORT,
  persistent: false,
});
await pg.initialise();
await pg.start();
await pg.createDatabase(DB_NAME);

const DATABASE_URL = `postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;
process.env.DATABASE_URL = DATABASE_URL;

// Scratch workspace the battery tasks run inside.
const WS = path.join(os.tmpdir(), `orplex-agent-ci-ws-${Date.now()}`);
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, "util.js"), "function slugify(s) { return s.toLowerCase().trim(); }\nmodule.exports = { slugify };\n");
fs.mkdirSync(path.join(WS, "tests"), { recursive: true });
fs.writeFileSync(
  path.join(WS, "tests", "util.test.js"),
  "const test = require('node:test'); const assert = require('node:assert');\nconst { slugify } = require('../util.js');\ntest('strips emoji', () => assert.equal(slugify('Caf\\u2615 A'), 'caf-a'));\n"
);
fs.mkdirSync(path.join(WS, "src"), { recursive: true });
fs.writeFileSync(path.join(WS, "src", "math.js"), "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");
execSync("git init -q", { cwd: WS });
execSync("git config user.email ci@orplex.local", { cwd: WS });
execSync("git config user.name ci", { cwd: WS });
execSync("git add -A", { cwd: WS });
execSync("git commit -qm init", { cwd: WS });
log(`scratch workspace ready at ${WS}`);

let server = null;
const cleanup = async () => {
  if (server && !server.killed) {
    try { server.kill(); } catch {}
  }
  try { await pg.stop(); } catch {}
  if (!KEEP) {
    try { execSync("git worktree prune", { cwd: WS }); } catch {}
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(ROOT, ".ci-agent-pg"), { recursive: true, force: true }); } catch {}
  }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });

try {
  // ── 1.5 Deterministic gates — exit codes only, no self-grading ──────────
  // The repo under test must pass the machine's own graders before the
  // battery runs at all. Any nonzero exit fails the whole run here, loudly.
  const GATES = [
    { name: "typecheck", cmd: "npx tsc --noEmit" },
    { name: "tests", cmd: "npx jest --silent --forceExit" },
    { name: "lint", cmd: "npx eslint . --max-warnings 0" },
  ];
  if (SKIP_GATES) {
    console.log("[agent-ci] ⚠ deterministic gates SKIPPED (--skip-gates) — local iteration only");
  } else {
    log("running deterministic gates (tsc / jest / eslint — exit codes only)");
    const gateResults = [];
    for (const gate of GATES) {
      const t0 = Date.now();
      const code = await run(gate.cmd, { quiet: false });
      gateResults.push({ name: gate.name, exit: code, ms: Date.now() - t0 });
      if (code !== 0) {
        console.log(`\n=== Deterministic gates — HARD FAIL ===`);
        for (const g of gateResults) {
          console.log(`  ${g.exit === 0 ? "PASS" : "FAIL"}  ${g.name}  (exit ${g.exit}, ${Math.round(g.ms / 1000)}s)`);
        }
        console.log(`  ⏸  ${gate.name} exited ${code} — battery refused to run (no self-grading: exit codes are the only verdict)`);
        process.exitCode = 1;
        throw new Error(`gate "${gate.name}" failed (exit ${code})`);
      }
    }
    console.log("=== Deterministic gates — all PASS (exit codes only) ===");
    for (const g of gateResults) console.log(`  PASS  ${g.name}  (${Math.round(g.ms / 1000)}s)`);
  }

  // ── 2. Push schema + mint the CI principal ──────────────────────────
  log("pushing prisma schema");
  if ((await run(`npx prisma db push --skip-generate`, { quiet: true })) !== 0) {
    throw new Error("prisma db push failed");
  }
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const user = await prisma.user.create({
    data: {
      id: "ci-agent-user",
      email: "ci-agent@orplex.local",
      name: "agent-ci",
      workspacePath: WS, // resolveWorkspaceCwd falls back here per-process
    },
  });
  await prisma.$disconnect();

  // ── 3. Start the Next server with the fixture provider + executor on ────
  const PORT = 5411 + (process.pid % 40);
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("No production build found — run `npm run build` before agent CI (the executor runs under `next start`).");
  }
  log(`starting next server on :${PORT} (ORPLEX_SERVER_EXECUTOR=1, AI_PROVIDER=ci-fixture)`);
  server = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      NEXTAUTH_SECRET: "ci-only-secret-agent-runner",
      NEXTAUTH_URL: `http://localhost:${PORT}`,
      ORPLEX_SERVER_EXECUTOR: "1",
      ORPLEX_PUSH_BRANCH: "0",
      AI_PROVIDER: "ci-fixture", // per-task scripts ride in modelOverride
      AGENT_EXEC_DISABLED: "0",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!(await waitForPort(PORT, 60_000))) throw new Error(`next server did not open :${PORT}`);
  log("server up — seeding battery runs");

  // ── 4. Seed one server run per task; the executor leases them for real ──
  const prisma2 = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const runRows = [];
  for (const t of tasks) {
    const row = await prisma2.agentRun.create({
      data: {
        userId: user.id,
        prompt: t.prompt,
        workspace: path.basename(WS),
        executionTarget: "server",
        status: "pending",
        autonomyPolicy: "auto", // no approval gate in CI — the loop must run to completion
        modelOverride: JSON.stringify({ __ciFixtureTurns: t.fixture }),
      },
    });
    runRows.push({ task: t, row });
    log(`seeded ${t.name} (run ${row.id.slice(-6)})`);
  }

  // ── 5. Wait for every run to reach a terminal status ────────────────────
  const TERMINAL = new Set(["completed", "failed", "error"]);
  const deadline = Date.now() + 10 * 60_000;
  let done = 0;
  while (done < runRows.length && Date.now() < deadline) {
    await sleep(2000);
    const rows = await prisma2.agentRun.findMany({ where: { id: { in: runRows.map((r) => r.row.id) } }, select: { id: true, status: true } });
    done = rows.filter((r) => TERMINAL.has(r.status)).length;
  }
  const finalRows = await prisma2.agentRun.findMany({ where: { id: { in: runRows.map((r) => r.row.id) } } });
  await prisma2.$disconnect();

  // ── 6. HARD verdicts — exit codes only, on the produced output ─────────
  const results = [];
  for (const { task, row } of runRows) {
    const run = finalRows.find((r) => r.id === row.id);
    const result = run?.result || {};
    // The executor puts the worktree (with the agent's real writes) under
    // .orplex-workspaces/<runId>/wt — the workspacePath sits beside it.
    const wtRoot = path.join(WS, "..", ".orplex-workspaces");
    const wtDir = result.worktreeDir
      ? result.worktreeDir
      : (() => {
          try {
            const dirs = fs.readdirSync(wtRoot).filter((d) => d.includes(row.id.slice(0, 8)));
            return dirs.length ? path.join(wtRoot, dirs[0], "wt") : null;
          } catch { return null; }
        })();

    const dir = wtDir && fs.existsSync(wtDir) ? wtDir : WS;
    log(`verifying ${task.name} against ${dir}`);
    const verifyCode = await run(task.verify, { cwd: dir, quiet: false });
    const executorOk = run?.status === "completed";
    results.push({
      name: task.name,
      executor: run?.status || "unknown",
      verifyExit: verifyCode,
      verdict: executorOk && verifyCode === 0 ? "PASS" : "FAIL",
    });
  }

  // ── 7. Report + exit ───────────────────────────────────────────────────
  console.log("\n=== Agent CI battery — HARD verdicts (exit-code evidence only) ===");
  for (const r of results) {
    console.log(`  ${r.verdict === "PASS" ? "PASS" : "FAIL"}  ${r.name}  (executor: ${r.executor}, verify exit: ${r.verifyExit})`);
  }
  const failed = results.filter((r) => r.verdict !== "PASS");
  console.log(`\n${results.length - failed.length}/${results.length} task(s) PASSED`);
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`[agent-ci] FATAL: ${err?.message || err}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
