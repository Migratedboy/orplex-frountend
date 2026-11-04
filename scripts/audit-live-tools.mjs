#!/usr/bin/env node
/**
 * audit-live-tools.mjs — Operation Zero Failure SUS-03 verification.
 *
 * Verifies REAL provider tool-calling (not mocks) for one compact-tier
 * provider (groq) and one full-tier provider (openrouter): send a single
 * tool schema (read_file, straight from tool-definitions.ts), ask a question
 * that should trigger it, and check the response carries a well-formed tool
 * call whose arguments parse as JSON with the required `path` field.
 *
 * Keys are read from .env and NEVER printed. Results are honest: a provider
 * that errors is reported as failed, not skipped silently.
 */
import fs from "node:fs";

function readKey(name) {
  if (!fs.existsSync(".env")) return null;
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(new RegExp(`^${name}=(.*)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// The exact schema the app registers (subset of tool-definitions.ts).
const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file. Returns the full file content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path to the file" } },
      required: ["path"],
    },
  },
};

async function listModels(name, base, key) {
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
  const data = await res.json();
  const ids = (data.data ?? data.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  if (!ids.length) throw new Error("models list empty");
  return ids;
}

async function toolCallProbe(name, base, key, model, forced) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a coding agent. Use the read_file tool to inspect files when asked about their contents." },
        { role: "user", content: "What does the file package.json contain? Read it." },
      ],
      tools: [READ_FILE_TOOL],
      ...(forced
        ? { tool_choice: { type: "function", function: { name: "read_file" } } }
        : { tool_choice: "auto" }),
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const calls = msg.tool_calls ?? [];
  if (!calls.length) {
    // Honest report: model answered in prose instead of calling the tool.
    return { ok: false, detail: `no tool_calls in response (finish=${data.choices?.[0]?.finish_reason ?? "?"})` };
  }
  const call = calls.find((c) => c.function?.name === "read_file");
  if (!call) return { ok: false, detail: `tool_calls present but no read_file (${calls.map((c) => c.function?.name).join(",")})` };
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { ok: false, detail: `read_file called but arguments are not valid JSON: ${String(call.function.arguments).slice(0, 80)}` };
  }
  if (typeof args.path !== "string" || !args.path) {
    return { ok: false, detail: `read_file called but missing required arg path (${JSON.stringify(args).slice(0, 80)})` };
  }
  return { ok: true, detail: `read_file({ path: ${JSON.stringify(args.path)} }) via ${model}` };
}

async function verify(name, base, key, opts = {}) {
  if (!key) return { name, ok: false, detail: "no API key in .env" };
  const failures = [];
  try {
    const models = await listModels(name, base, key);
    const candidates = (opts.pick ? opts.pick(models) : [models[0]]).filter(Boolean).slice(0, 3);
    for (const model of candidates) {
      for (const forced of [false, true]) {
        try {
          const probe = await toolCallProbe(name, base, key, model, forced);
          if (probe.ok) return { name, ...probe };
          failures.push(`${model}${forced ? " (forced choice)" : ""}: ${probe.detail}`);
        } catch (err) {
          failures.push(`${model}${forced ? " (forced choice)" : ""}: ${String(err.message ?? err).slice(0, 140)}`);
        }
      }
    }
    return { name, ok: false, detail: failures.join(" | ").slice(0, 400) };
  } catch (err) {
    return { name, ok: false, detail: String(err.message ?? err).slice(0, 200) };
  }
}

const results = [];
results.push(
  await verify("groq (compact tier)", "https://api.groq.com/openai/v1", readKey("GROQ_API_KEY"), {
    pick: (models) => models.filter((id) => /llama-3\.3|llama-3\.1|qwen|deepseek/i.test(id)),
  })
);
results.push(
  await verify("openrouter (full tier, :free models)", "https://openrouter.ai/api/v1", readKey("OPENROUTER_API_KEY"), {
    pick: (models) => models.filter((id) => id.endsWith(":free")),
  })
);

console.log("\n=== LIVE PROVIDER TOOL-CALL VERIFICATION (SUS-03) ===");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  —  ${r.detail}`);
}
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} providers returned a well-formed read_file tool call against their live API.`
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
