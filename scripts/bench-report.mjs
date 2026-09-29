#!/usr/bin/env node
// bench-report.mjs — Print the cost-adjusted benchmark report over TaskRun
// rows (backing script for `npm run bench:report`). Server-only: reads
// DATABASE_URL. Usage:
//   node scripts/bench-report.mjs [--days N] [--json]
//
// Rows come straight from the task_runs ledger; the aggregation math lives
// in src/lib/benchmark-report.ts (unit-tested). The cost model is an
// estimate from model-call counts — ambient reporting, never billing.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (!process.env.DATABASE_URL) {
  console.error("bench:report needs DATABASE_URL (the desktop app's .env supplies it; CI passes it explicitly)");
  process.exit(1);
}

const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : null;
const asJson = args.includes("--json");

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Load the tested aggregation core from source: plain node can't import TS,
// so transpile the single module with the TypeScript compiler API (same
// source file the unit tests exercise — no duplicated math here).
async function loadBenchmarkCore() {
  const ts = require("typescript");
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(ROOT, "src", "lib", "benchmark-report.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)(require, mod, mod.exports);
  return mod.exports;
}

const { buildBenchmarkReport, formatBenchmarkReport } = await loadBenchmarkCore();

const rows = await prisma.taskRun.findMany({
  ...(days != null && Number.isFinite(days) && days > 0
    ? { where: { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } } }
    : {}),
  orderBy: { createdAt: "desc" },
  take: 10_000,
});

const report = buildBenchmarkReport(
  rows.map((r) => ({
    finalStatus: r.finalStatus,
    mode: r.mode,
    typecheckLane: r.typecheckLane,
    browserLane: r.browserLane,
    swarmLane: r.swarmLane,
    modelCalls: r.modelCalls,
    tokensSaved: r.tokensSaved,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  })),
  { windowDays: days != null && Number.isFinite(days) && days > 0 ? days : null }
);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatBenchmarkReport(report));
}
await prisma.$disconnect();
