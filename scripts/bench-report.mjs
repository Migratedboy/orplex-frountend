#!/usr/bin/env node
// bench-report.mjs — Print the cost-adjusted benchmark report over TaskRun
// rows (backing script for `npm run bench:report`). Server-only: reads
// DATABASE_URL. Usage:
//   node scripts/bench-report.mjs [--days N] [--json]
//
// Rows come straight from the task_runs ledger; the aggregation math lives in
// THIS file — it used to live in src/lib/benchmark-report.ts, which was
// removed, and this comment still pointed at it. The cost model is an
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
// so transpile the modules on demand with the TypeScript compiler API (same
// source files the unit tests exercise — no duplicated math here).
//
// The shim require below is required because the core imports ./cost-estimator
// (ONE rate table, deliberately not duplicated into this file). A bare
// `require` rooted at this script would resolve "./cost-estimator" against
// scripts/ and then fail to load a .ts file at all.
async function loadBenchmarkCore() {
  const ts = require("typescript");
  const fs = await import("node:fs");
  const libDir = path.join(ROOT, "src", "lib");

  const transpile = (file) =>
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esInterop: true,
      },
    }).outputText;

  const cache = new Map();
  // Load a TS module from src/lib, memoized, so a diamond import loads once.
  const loadTs = (file) => {
    const abs = path.resolve(file);
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const shimRequire = (spec) => {
      if (spec.startsWith(".")) {
        let target = path.resolve(path.dirname(abs), spec);
        if (!path.extname(target)) target += ".ts";
        if (fs.existsSync(target)) return loadTs(target);
        // Directory import -> index.ts
        const idx = path.join(target, "index.ts");
        if (fs.existsSync(idx)) return loadTs(idx);
      }
      return require(spec);
    };
    new Function("require", "module", "exports", "__filename", "__dirname", transpile(abs))(
      shimRequire,
      mod,
      mod.exports,
      abs,
      path.dirname(abs)
    );
    return mod.exports;
  };

  return loadTs(path.join(libDir, "benchmark-report.ts"));
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
  {
    windowDays: days != null && Number.isFinite(days) && days > 0 ? days : null,
    // Recurring, unresolved failure signatures — the "what keeps breaking"
    // half of the report. Without it the ledger only answers "how often".
    failures: await prisma.taskFailure
      .findMany({
        where: {
          resolvedAt: null,
          ...(days != null && Number.isFinite(days) && days > 0
            ? { lastSeenAt: { gte: new Date(Date.now() - days * 86_400_000) } }
            : {}),
        },
        orderBy: { count: "desc" },
        take: 50,
      })
      .then((fs) =>
        fs.map((f) => ({
          kind: f.kind,
          detail: f.detail,
          count: f.count,
          lastSeenAt: f.lastSeenAt,
          resolvedAt: f.resolvedAt,
        }))
      ),
  }
);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatBenchmarkReport(report));
}
await prisma.$disconnect();
