#!/usr/bin/env node
// run-shard.mjs — Run a SHARD of SWE-bench Lite instances through the agent
// and emit one result JSON per instance. Matrix workflow: each shard runs in
// its own job.
//
// Usage:
//   node scripts/swe-bench/run-shard.mjs --instances instances.json \
//        --shard 0 --shards 2 [--source patch] [--out-dir results/]
//
//   --source patch   apply the dataset's GOLD patch (no agent) — smoke-tests
//                    the harness itself end-to-end
//   --source agent   run the Orplex agent to produce the patch (requires a
//                    reachable model provider; see ORPLEX_SWE_MODEL)
//
// Protocol per instance (measured only at the FAIL_TO_PASS tests):
//   1. clone the repo, checkout base_commit
//   2. apply test patch, run tests → must FAIL (pre state)
//   3. produce patch (gold or agent), apply → run tests → must PASS (post)
//
// Results: results/<shard>/<instanceId>.json {instanceId, verdict, pre,
// post, durationMs, patchSource, error?}. Verdict PASS requires pre fail AND
// post pass (never trust a suite that was green before the fix).
//
// CAVEAT (documented): this harness measures the FAIL_TO_PASS commands
// as recorded in the dataset, on a plain clone. It is NOT the official
// SWE-bench evaluation (no per-instance docker environments, no
// PASS_TO_PASS regression sweep by default). Spot-check against the official
// leaderboard before quoting numbers.

import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);

const INSTANCES_FILE = opt("--instances", "swe-bench-instances.json");
const SHARD = Number(opt("--shard", 0));
const SHARDS = Math.max(1, Number(opt("--shards", 1)));
const SOURCE = opt("--source", "patch"); // patch | agent
const OUT_DIR = opt("--out-dir", "results");

if (!fs.existsSync(INSTANCES_FILE)) {
  console.error(`[swe-bench] instances file not found: ${INSTANCES_FILE} (run fetch-instances.mjs first)`);
  process.exit(1);
}
const all = JSON.parse(fs.readFileSync(INSTANCES_FILE, "utf8"));
const shardInstances = all.filter((_, i) => i % SHARDS === SHARD);
if (shardInstances.length === 0) {
  console.log(`[swe-bench] shard ${SHARD}/${SHARDS} has no instances — nothing to do`);
  process.exit(0);
}

// Clone cache: lives in the workdir on GH (one checkout per instance per
// job) and can be pointed at a persistent dir locally via ORPLEX_SWE_WORK_DIR.
const WORK_ROOT = process.env.ORPLEX_SWE_WORK_DIR
  ? path.resolve(process.env.ORPLEX_SWE_WORK_DIR)
  : path.resolve(".swe-bench-work");
fs.mkdirSync(WORK_ROOT, { recursive: true });
const shardDir = path.join(OUT_DIR, String(SHARD));
fs.mkdirSync(shardDir, { recursive: true });

const PER_INSTANCE_TIMEOUT_MS = Number(process.env.ORPLEX_SWE_TIMEOUT_MS || 0) || 20 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

function sh(cmd, cwd, timeoutMs) {
  return spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

/** Pick the test command from the dataset's test_patch + test_directives. */
function buildTestCommand(inst) {
  // The test patch's diff tells us the test files; run pytest on exactly those.
  const files = new Set();
  for (const m of inst.testPatch.matchAll(/^\+\+\+ b\/(tests?\/[^\s"']+\.py)/gm)) {
    files.add(m[1]);
  }
  if (files.size === 0) return null;
  return `python -m pytest -x -q ${[...files].join(" ")}`;
}

/** Run the instance's tests, return {ok, output, code}. */
function runTests(cmd, cwd) {
  const r = sh(cmd, cwd, PER_INSTANCE_TIMEOUT_MS / 2);
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.slice(-20_000), code: r.status };
}

/** Extract python test node ids from FAIL_TO_PASS JSON list. */
function filterFailToPass(output, failToPass) {
  if (!failToPass || failToPass.length === 0) return true; // no directives: fall back to exit code
  const missing = failToPass.filter((t) => !output.includes(t));
  return missing.length === 0;
}

function writeResult(dir, result) {
  const safeName = result.instanceId.replace(/[^\w.-]+/g, "__");
  fs.writeFileSync(path.join(dir, `${safeName}.json`), JSON.stringify(result, null, 2));
}

let passCount = 0;
const started = Date.now();
for (const inst of shardInstances) {
  const t0 = Date.now();
  const repoDir = path.join(WORK_ROOT, inst.instanceId.replace(/[^\w.-]+/g, "__"));
  const result = {
    instanceId: inst.instanceId,
    repo: inst.repo,
    baseCommit: inst.baseCommit,
    source: SOURCE,
    verdict: "ERROR",
    pre: null,
    post: null,
    durationMs: 0,
    error: null,
  };
  try {
    console.log(`\n[swe-bench] ▶ ${inst.instanceId} (${SOURCE})`);
    // 1. Clone (shared cache across shards on the same runner) + checkout.
    if (!fs.existsSync(path.join(repoDir, ".git"))) {
      execSync(`git clone --quiet ${SOURCE === "patch" ? "--filter=blob:none" : ""} https://github.com/${inst.repo}.git "${repoDir}"`, {
        stdio: "inherit",
        timeout: CLONE_TIMEOUT_MS,
        env: process.env,
      });
    }
    sh(`git fetch --quiet origin ${inst.baseCommit} && git checkout --quiet --force ${inst.baseCommit} && git clean -fdxq`, repoDir, 120_000);

    // 2. Test patch → pre state must FAIL on FAIL_TO_PASS.
    const testCmd = buildTestCommand(inst);
    if (!testCmd) throw new Error("could not derive a test command from the test patch");
    fs.writeFileSync(path.join(repoDir, "test.patch"), inst.testPatch);
    const apply = sh(`git apply --whitespace=nowarn test.patch`, repoDir, 60_000);
    if (apply.status !== 0) throw new Error(`test patch failed to apply: ${(apply.stderr || "").slice(-300)}`);
    result.pre = runTests(testCmd, repoDir);
    if (result.pre.ok) {
      // Triage signal, not a verdict flip: the pre-state was already green.
      result.verdict = "INVALID";
      result.error = "FAIL_TO_PASS tests passed BEFORE the patch — harness or dataset issue";
      writeResult(shardDir, { ...result, durationMs: Date.now() - t0 });
      console.log(`[swe-bench] ⚠ ${inst.instanceId}: INVALID (pre already green)`);
      continue;
    }
    const preHit = filterFailToPass(result.pre.output, inst.failToPass);
    if (!preHit) {
      result.verdict = "INVALID";
      result.error = "pre-state output does not mention the FAIL_TO_PASS tests (command mismatch?)";
      writeResult(shardDir, { ...result, durationMs: Date.now() - t0 });
      continue;
    }

    // 3. Patch source: gold patch (harness smoke test) or the agent.
    if (SOURCE === "agent") {
      // Agent integration is a COMMAND HOOK, not an invented internal API:
      // ORPLEX_SWE_AGENT_CMD receives ORPLEX_SWE_REPO_DIR +
      // ORPLEX_SWE_PROMPT_FILE in its environment and must leave its changes
      // in the working tree — the harness diffs them. Point it at your
      // Orplex install, another agent CLI, or a stub.
      const agentCmd = process.env.ORPLEX_SWE_AGENT_CMD;
      if (!agentCmd) throw new Error("--source agent requires ORPLEX_SWE_AGENT_CMD (a command that edits the repo; gets ORPLEX_SWE_REPO_DIR + ORPLEX_SWE_PROMPT_FILE)");
      const promptFile = path.join(WORK_ROOT, `${inst.instanceId.replace(/[^\w.-]+/g, "__")}.prompt.txt`);
      fs.writeFileSync(
        promptFile,
        [
          `Fix this issue in the repository at ${repoDir}.`,
          `Problem statement:\n${inst.problemStatement}`,
          `When done, ensure the failing tests pass: ${inst.failToPass.join(", ")}`,
        ].join("\n\n")
      );
      const agentRun = sh(agentCmd, process.cwd(), PER_INSTANCE_TIMEOUT_MS);
      if (agentRun.status !== 0) {
        throw new Error(`agent command failed (exit ${agentRun.status}): ${(agentRun.stderr || agentRun.stdout || "").slice(-400)}`);
      }
    } else {
      fs.writeFileSync(path.join(repoDir, "gold.patch"), inst.modelPatch || "");
      const gold = sh(`git apply --whitespace=nowarn gold.patch`, repoDir, 60_000);
      if (gold.status !== 0) throw new Error(`gold patch failed to apply: ${(gold.stderr || "").slice(-300)}`);
    }

    // 4. Post state must PASS.
    result.post = runTests(testCmd, repoDir);
    const postHit = filterFailToPass(result.post.output, inst.failToPass);
    if (result.post.ok && postHit) {
      result.verdict = "PASS";
      passCount++;
    } else {
      result.verdict = "FAIL";
    }
  } catch (err) {
    result.verdict = "ERROR";
    result.error = String(err?.message || err).slice(0, 1000);
  } finally {
    result.durationMs = Date.now() - t0;
    writeResult(shardDir, result);
    console.log(`[swe-bench] ■ ${inst.instanceId}: ${result.verdict} (${Math.round(result.durationMs / 1000)}s)`);
    // Best-effort cleanup between instances (keep the clone for cache reuse).
    // Sequential argv-free shell calls — no compound commands to stay portable.
    sh("git checkout --quiet --force", repoDir, 60_000);
    sh("git clean -fdxq", repoDir, 60_000);
    sh("git apply -R --whitespace=nowarn test.patch", repoDir, 60_000);
  }
}

console.log(`\n[swe-bench] shard ${SHARD}/${SHARDS}: ${passCount}/${shardInstances.length} PASS in ${Math.round((Date.now() - started) / 1000)}s`);
process.exitCode = 0; // merge-results.mjs decides overall pass/fail
