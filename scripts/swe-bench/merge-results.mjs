#!/usr/bin/env node
// merge-results.mjs — Combine per-shard result JSONs into one summary.
// Verdict-first, house style. Exit 0 always — this is a REPORT, not a gate
// (a benchmark run failing to solve instances is a measurement, not a CI
// failure; harness errors ARE surfaced in the summary).
//
// Usage: node scripts/swe-bench/merge-results.mjs --results-dir results [--json]

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const idx = args.indexOf("--results-dir");
const dir = idx >= 0 ? args[idx + 1] : "results";
const asJson = args.includes("--json");

const results = [];
if (fs.existsSync(dir)) {
  for (const shard of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, shard.name))) {
      if (!f.endsWith(".json")) continue;
      try {
        results.push(JSON.parse(fs.readFileSync(path.join(dir, shard.name, f), "utf8")));
      } catch {
        // A torn/partial artifact from a killed job — count it as an error row.
        results.push({ instanceId: f, verdict: "ERROR", error: "unparseable result file" });
      }
    }
  }
}

const byVerdict = { PASS: 0, FAIL: 0, INVALID: 0, ERROR: 0 };
for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
const total = results.length;
const resolved = byVerdict.PASS / Math.max(1, total);
const source = results[0]?.source || "unknown";

if (asJson) {
  console.log(JSON.stringify({ total, ...byVerdict, resolvedRate: resolved, source, results }, null, 2));
  process.exit(0);
}

console.log("=== SWE-bench Lite (Orplex harness) ===");
console.log(`Instances: ${total} — ${byVerdict.PASS} PASS · ${byVerdict.FAIL} FAIL · ${byVerdict.INVALID} INVALID · ${byVerdict.ERROR} ERROR`);
console.log(`Resolved: ${(resolved * 100).toFixed(1)}% (patch source: ${source})`);
const errs = results.filter((r) => r.verdict === "ERROR" && r.error);
if (errs.length > 0) {
  console.log("Harness errors:");
  for (const e of errs.slice(0, 10)) console.log(`  ${e.instanceId}: ${String(e.error).slice(0, 160)}`);
}
console.log("");
console.log("CAVEAT: not the official SWE-bench evaluation — plain clones, no per-instance");
console.log("docker environments, no PASS_TO_PASS regression sweep by default. Spot-check");
console.log("against the official leaderboard before quoting these numbers.");
