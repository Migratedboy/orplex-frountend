/**
 * migrate-to-cloud.js — move the ENTIRE local DB (.orplex/db/<model>.json)
 * into the cloud Postgres (DATABASE_URL) when the team is ready.
 *
 * Usage:
 *   1. Set DATABASE_URL in .env.local (Supabase pooler, port 6543).
 *   2. npx prisma db push   (schema already matches — safe to run)
 *   3. node scripts/migrate-to-cloud.js --dry-run   (preview, no writes)
 *   4. node scripts/migrate-to-cloud.js             (real run)
 *
 * Guarantees:
 * - Idempotent: createMany + skipDuplicates, ids preserved. Re-run = no-ops.
 * - Ordered parents-first (user/workspace/conversation/agentRun before children)
 *   so FK checks pass on strict Postgres.
 * - Corrupt files are SKIPPED with a loud warning, never migrated as junk.
 * - Local files are untouched. Cut-over is a separate, reversible step.
 *
 * NOTE: workspaceMemory lives in .orplex/workspace-memory.json (not the
 * facade). Export it separately with exportSnapshot() from local-db.ts.
 */
"use strict";
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { PrismaClient } = require("@prisma/client");
const path = require("node:path");

const DRY = process.argv.includes("--dry-run");
const DB_DIR = process.env.ORPLEX_LOCAL_DB_DIR
  ? path.resolve(process.env.ORPLEX_LOCAL_DB_DIR)
  : path.join(process.cwd(), ".orplex", "db");

// Parents-first migration order (Postgres FK-safe).
const ORDER = [
  "user", "account", "session", "verificationToken", "learning",
  "workspace", "workspaceMember", "projectRecord",
  "conversation", "message",
  "task", "toolCall", "pipelineStep",
  "agentRun", "agentTask", "agentTaskDependency", "runEvent",
  "agentArtifact", "comment", "runCheckpoint", "approvalRequest",
  "notification", "providerEvent", "syncEvent",
  "apiKeyPool", "usageLog", "userQuota", "userApiKey",
  "rateLimitWindow", "circuitBreakerState",
  "vectorMemoryEntry", "sonaPattern", "sonaTrajectory",
  "taskRun", "taskFailure", "workspaceMemory",
  "mcpServerConfig", "mcpConnection", "mcpOAuthPending", "mcpTool",
  "memoryFile", "memorySetting",
];

const prisma = new PrismaClient();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[migrate] DATABASE_URL is not set — aborting.");
    process.exit(1);
  }
  if (!existsSync(DB_DIR)) {
    console.error(`[migrate] local db dir not found: ${DB_DIR}`);
    process.exit(1);
  }
  const present = new Set(
    readdirSync(DB_DIR).map((f) => f.replace(/\.json$/, ""))
  );

  const summary = {};
  for (const model of ORDER) {
    if (!present.has(model)) {
      summary[model] = "absent (skipped)";
      continue;
    }
    const file = path.join(DB_DIR, `${model}.json`);
    let rows;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      rows = parsed;
    } catch (e) {
      console.warn(`[migrate] SKIP ${model}: corrupt file (${String(e.message).slice(0, 80)})`);
      summary[model] = "CORRUPT (skipped)";
      continue;
    }
    const delegate = prisma[model];
    if (!delegate?.createMany) {
      console.warn(`[migrate] SKIP ${model}: no cloud delegate`);
      summary[model] = "no cloud model (skipped)";
      continue;
    }
    // JSON files store Dates as ISO strings — Prisma wants Date objects.
    const data = rows.map((r) => {
      const out = { ...r };
      for (const k of Object.keys(out)) {
        const v = out[k];
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) {
          out[k] = new Date(v);
        }
      }
      return out;
    });
    if (DRY) {
      summary[model] = `${rows.length} row(s) (dry-run)`;
      continue;
    }
    try {
      const res = await delegate.createMany({ data, skipDuplicates: true });
      summary[model] = `${res.count} inserted / ${rows.length} total`;
      console.log(`[migrate] ${model}: ${res.count} inserted (${rows.length} local rows)`);
    } catch (e) {
      console.warn(`[migrate] FAILED ${model}: ${String(e.message).slice(0, 140)}`);
      summary[model] = `FAILED: ${String(e.message).slice(0, 80)}`;
    }
  }
  console.log("\n=== summary ===");
  console.log(JSON.stringify(summary, null, 1));
  if (DRY) console.log("\n(dry-run — nothing written)");
}

main()
  .catch((e) => {
    console.error("[migrate] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
