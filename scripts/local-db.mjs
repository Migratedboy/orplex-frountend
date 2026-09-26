// scripts/local-db.mjs — Run a local PostgreSQL without Docker/admin rights.
//
// Usage:
//   node scripts/local-db.mjs start     # start server (background-safe; keeps running)
//   node scripts/local-db.mjs stop      # stop the server started above
//   node scripts/local-db.mjs status    # 0 if running, 1 if not
//
// Data + logs live under .localpg/ (gitignored). Port/db/user/password come from
// env with sane defaults matching .env (DATABASE_URL=...://postgres:postgres@localhost:5433/orplex).

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// initdb requires an EMPTY dir — keep runner.json/logs in .localpg/, raw cluster data in .localpg/data/
const dataDir = path.join(root, ".localpg", "data");
const pidFile = path.join(root, ".localpg", "runner.json");

const PORT = Number(process.env.LOCAL_DB_PORT || 5433);
const DB_NAME = process.env.LOCAL_DB_NAME || "orplex";
const DB_USER = process.env.LOCAL_DB_USER || "postgres";
const DB_PASSWORD = process.env.LOCAL_DB_PASSWORD || "postgres";

function readRunner() {
  try {
    return JSON.parse(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
}

function writeRunner(info) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify(info, null, 2));
}

function isPortOpen(port, host = "127.0.0.1", timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function start() {
  if (await isPortOpen(PORT)) {
    const prev = readRunner();
    if (!prev || !prev.pid) {
      writeRunner({ pid: null, port: PORT, external: true });
    }
    console.log(`[local-db] Postgres already listening on port ${PORT} — reusing it.`);
    process.exit(0);
  }

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: DB_USER,
    password: DB_PASSWORD,
    port: PORT,
    persistent: true,
    // Windows defaults initdb to WIN1252, which rejects emoji/multibyte text
    // (Prisma error 22P05). Force a UTF-8 cluster with the C locale.
    initdbFlags: ["-E", "UTF8", "--locale=C"],
    onLog: () => {},          // keep stdout clean
    onError: (m) => console.error("[local-db] pg:", String(m).slice(0, 200)),
  });

  fs.mkdirSync(dataDir, { recursive: true });
  // initdb fails if the dir already holds a cluster — only initialise a fresh one.
  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    await pg.initialise();
  }
  await pg.start();            // launches postgres
  try {
    await pg.createDatabase(DB_NAME);
  } catch {
    // already exists — fine (initdb created the default db; orplex may pre-exist)
  }

  writeRunner({ pid: process.pid, port: PORT });

  // Keep the server alive as long as this process lives (use with `start`).
  console.log(`[local-db] Postgres ready on port ${PORT} (db=${DB_NAME} user=${DB_USER})`);
  const shutdown = async () => {
    try { await pg.stop(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => {}, 1 << 30); // hold the event loop open
}

async function stop() {
  const info = readRunner();
  if (!info || !info.pid) {
    console.log("[local-db] no runner info — nothing to stop");
    process.exit(0);
  }
  if (info.external) {
    console.log(`[local-db] port ${info.port} was already in use by another process; leaving it alone`);
    process.exit(0);
  }
  try {
    process.kill(info.pid, "SIGINT");
    console.log(`[local-db] sent stop signal to pid ${info.pid}`);
  } catch (e) {
    console.log(`[local-db] could not signal pid ${info.pid}: ${e.message}`);
  }
  process.exit(0);
}

async function status() {
  const open = await isPortOpen(PORT);
  console.log(open ? "running" : "stopped");
  process.exit(open ? 0 : 1);
}

const cmd = process.argv[2] || "start";
if (cmd === "start") await start();
else if (cmd === "stop") await stop();
else if (cmd === "status") await status();
else {
  console.error("usage: node scripts/local-db.mjs [start|stop|status]");
  process.exit(2);
}
