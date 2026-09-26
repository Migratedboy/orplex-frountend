#!/usr/bin/env node
/**
 * test-models.mjs — Live-test every model in the picker catalog.
 *
 * Reads .model-catalog-cache.json (the list shown in the prompt bar) and sends
 * a tiny real chat completion to each model through its provider API. Free
 * models that answer 429 (busy, not dead) are retried with backoff so we get
 * an actual reply from each one. Prints a pass/fail table and writes
 * .model-test-results.json for reference.
 *
 * Usage: node scripts/test-models.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const CATALOG = ".model-catalog-cache.json";
const OUT = ".model-test-results.json";

// ---- env (parse .env without deps) ----------------------------------------
function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}
loadEnv();

const KEYS = {
  groq: process.env.GROQ_API_KEY || "",
  openrouter: process.env.OPENROUTER_API_KEY || "",
  nvidia: process.env.NVIDIA_API_KEY || "",
};
const URLS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
};

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4; // first try + up to 3 retries on 429
const BACKOFF_MS = [4_000, 8_000, 12_000];
const STAGGER_MS = 1_200; // between starts, per provider
const CONCURRENCY = 2; // gentle on free tiers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(provider, id) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(URLS[provider], {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEYS[provider]}`,
        ...(provider === "openrouter"
          ? { "HTTP-Referer": "http://localhost:5000", "X-Title": "Orplex model test" }
          : {}),
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        max_tokens: 32,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (res.status === 429) return { status: "rate_limited", http: 429, ms, reply: null };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: "http_error", http: res.status, ms, reply: body.slice(0, 140) };
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return { status: "bad_content_type", http: res.status, ms, reply: null };
    const json = await res.json();
    if (json.error) {
      const code = Number(json.error.code ?? 0);
      return code === 429
        ? { status: "rate_limited", http: 429, ms, reply: null }
        : { status: "embedded_error", http: 200, ms, reply: String(json.error.message ?? "").slice(0, 140) };
    }
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    return { status: "ok", http: 200, ms, reply: (text || `(empty content, finish=${choice?.finish_reason})`).slice(0, 60) };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = err?.name === "AbortError";
    return { status: aborted ? "timeout" : "network_error", http: 0, ms, reply: String(err?.message ?? err).slice(0, 140) };
  } finally {
    clearTimeout(t);
  }
}

async function testModel(m) {
  const attempts = [];
  let last = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) await sleep(BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]);
    last = await callModel(m.provider, m.id);
    attempts.push({ n: i + 1, status: last.status, http: last.http, ms: last.ms });
    if (last.status === "ok") break;
    if (last.status !== "rate_limited") break; // only retry genuine 429s
  }
  // After all retries, a 429 means the provider confirmed the model serves
  // but is rate-limiting us — alive, not dead.
  const verdict =
    last.status === "ok"
      ? "PASS"
      : last.status === "rate_limited"
        ? "ALIVE-THROTTLED"
        : "FAIL";
  return {
    id: m.id,
    provider: m.provider,
    verdict,
    attempts,
    finalStatus: last.status,
    http: last.http,
    ms: last.ms,
    reply: last.reply,
  };
}

// ---- runner: concurrency-limited, staggered per provider --------------------
async function run(models) {
  const results = new Array(models.length);
  let next = 0;
  const lastStart = { groq: 0, openrouter: 0, nvidia: 0 };
  const worker = async () => {
    while (next < models.length) {
      const idx = next++;
      const m = models[idx];
      const gap = Date.now() - lastStart[m.provider];
      if (gap < STAGGER_MS) await sleep(STAGGER_MS - gap);
      lastStart[m.provider] = Date.now();
      process.stdout.write(`testing ${m.provider}/${m.id} ...\r`);
      results[idx] = { ...(await testModel(m)), index: idx };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker));
  return results;
}

// ---- main -------------------------------------------------------------------
const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const models = catalog.models;
console.log(`Testing ${models.length} catalog models against live provider APIs...\n`);

const t0 = Date.now();
const results = await run(models);

// restore catalog order and print
results.sort((a, b) => a.index - b.index);
const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + "=".repeat(96));
for (const r of results) {
  const mark = r.verdict === "PASS" ? "✓" : r.verdict === "ALIVE-THROTTLED" ? "~" : "✗";
  console.log(
    `${mark} ${pad(r.verdict, 15)} ${pad(r.provider, 11)} ${pad(r.id, 62)} ` +
      `${r.finalStatus} (${r.ms}ms${r.attempts.length > 1 ? `, ${r.attempts.length} tries` : ""})` +
      (r.verdict === "FAIL" && r.reply ? `\n    └─ ${r.reply}` : "")
  );
}
console.log("=".repeat(96));
const pass = results.filter((r) => r.verdict === "PASS").length;
const throttled = results.filter((r) => r.verdict === "ALIVE-THROTTLED").length;
const fail = results.filter((r) => r.verdict === "FAIL").length;
console.log(
  `SUMMARY: ${results.length} models — ${pass} replied OK, ${throttled} alive but rate-limited, ${fail} failed. ` +
    `Took ${((Date.now() - t0) / 1000).toFixed(0)}s`
);

writeFileSync(OUT, JSON.stringify({ testedAt: new Date().toISOString(), summary: { pass, throttled, fail }, results }, null, 2));
console.log(`Full details written to ${OUT}`);
if (fail > 0) process.exitCode = 1;
