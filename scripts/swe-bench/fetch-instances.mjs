#!/usr/bin/env node
// fetch-instances.mjs — Pull SWE-bench Lite instances from the Hugging Face
// datasets-server JSON API (no HF account/token needed for public datasets)
// and write a normalized instances file for run-shard.mjs.
//
// Usage:
//   node scripts/swe-bench/fetch-instances.mjs --count 10 --out instances.json
//                                        [--offset 0] [--repo django/django]
//                                        [--cache prev.json]
//
// Each instance: { instanceId, repo, baseCommit, testPatch, failToPass[],
// passToPass[], problemStatement }.
//
// --cache reuses a previous fetch and only pulls rows not already present —
// for LOCAL reruns; GitHub Actions jobs are ephemeral and fetch fresh
// (datasets-server is free, no token, ~2s per page). A cache also makes the
// fetch deterministic across resume runs.

import fs from "node:fs";

const DATASET = "princeton-nlp/SWE-bench_Lite";
const API = "https://datasets-server.huggingface.co/rows";
const PAGE = 100; // datasets-server hard cap per call

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const COUNT = Math.max(1, Number(opt("--count", 10)));
const OFFSET = Math.max(0, Number(opt("--offset", 0)));
const REPO_FILTER = opt("--repo", null);
const OUT = opt("--out", "swe-bench-instances.json");
const CACHE_FILE = opt("--cache", null);

function jparse(v, fallback) {
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : fallback;
  } catch {
    return fallback;
  }
}

async function fetchPage(offset) {
  const url = `${API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${offset}&length=${PAGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`datasets-server HTTP ${res.status} at offset ${offset}`);
  const json = await res.json();
  return (json.rows || []).map((r) => r.row);
}

const wanted = [];
const seen = new Set();
if (CACHE_FILE && fs.existsSync(CACHE_FILE)) {
  try {
    for (const prev of JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))) {
      if (!seen.has(prev.instanceId)) {
        seen.add(prev.instanceId);
        wanted.push(prev);
      }
    }
    console.log(`[swe-bench] cache: ${wanted.length} instance(s) reused from ${CACHE_FILE}`);
  } catch {
    console.warn(`[swe-bench] cache file unreadable — fetching fresh`);
  }
}
let cursor = 0; // absolute row offset into the dataset
console.log(`[swe-bench] fetching up to ${COUNT} instance(s) (offset ${OFFSET}${REPO_FILTER ? `, repo=${REPO_FILTER}` : ""})`);
while (wanted.length < COUNT) {
  const rows = await fetchPage(cursor);
  if (rows.length === 0) break;
  for (let i = 0; i < rows.length && wanted.length < COUNT; i++) {
    if (cursor + i < OFFSET) continue; // skip rows below the requested offset
    const r = rows[i];
    if (REPO_FILTER && r.repo !== REPO_FILTER) continue;
    if (seen.has(r.instance_id)) continue;
    seen.add(r.instance_id);
    wanted.push({
      instanceId: r.instance_id,
      repo: r.repo,
      baseCommit: r.base_commit,
      environmentSetupCommit: r.environment_setup_commit,
      version: r.version,
      problemStatement: (r.problem_statement || "").slice(0, 16_000),
      modelPatch: r.patch || "", // gold patch — apply-mode smoke testing only
      testPatch: r.test_patch || "",
      failToPass: jparse(r.FAIL_TO_PASS, []),
      passToPass: jparse(r.PASS_TO_PASS, []),
    });
    if (wanted.length >= COUNT) break;
  }
  cursor += PAGE;
}

if (wanted.length === 0) {
  console.error("[swe-bench] no instances fetched — check connectivity/filters");
  process.exit(1);
}
fs.writeFileSync(OUT, JSON.stringify(wanted, null, 2));
console.log(`[swe-bench] wrote ${wanted.length} instance(s) → ${OUT}`);
for (const i of wanted) console.log(`  ${i.instanceId}  (${i.repo} @ ${i.baseCommit.slice(0, 8)})`);
