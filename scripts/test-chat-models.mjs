#!/usr/bin/env node
/** One-off: test every catalog model through the app's own /api/chat SSE path. */
const BASE = "http://localhost:5000";

async function main() {
  // 1. login (dev bypass) — capture cookie
  const login = await fetch(`${BASE}/api/dev/session?action=login`, { method: "GET" });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) {
    console.log("LOGIN FAILED:", login.status);
    process.exit(1);
  }
  console.log("logged in ✓\n");

  // 2. fetch the exact list the picker shows
  const cat = await fetch(`${BASE}/api/models/available`, { headers: { cookie } });
  const catJson = await cat.json();
  const models = catJson.models ?? [];
  console.log(`picker lists ${models.length} models — testing each through /api/chat:\n`);

  const results = [];
  for (const m of models) {
    const t0 = Date.now();
    let outcome;
    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
          model: m.id,
          stream: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        outcome = `HTTP ${res.status}: ${text.slice(0, 120)}`;
      } else {
        // read the SSE stream until we see content or an error event
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let sawContent = false;
        let sawError = "";
        let firstChunk = "";
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (!firstChunk && buf.trim()) firstChunk = buf.trim().slice(0, 150);
          for (const line of buf.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const j = JSON.parse(line.slice(5).trim());
              if (j.error) sawError = j.error.message ?? JSON.stringify(j.error).slice(0, 140);
              if (j.content || j.delta?.content || j.text) sawContent = true;
              if (j.done || j.finish || j.type === "done") {
                try { await reader.cancel(); } catch {}
              }
            } catch {}
          }
          if (sawContent || sawError) {
            try { await reader.cancel(); } catch {}
            break;
          }
        }
        const ms = Date.now() - t0;
        outcome = sawError ? `SSE-ERROR: ${sawError}` : sawContent ? `OK (${ms}ms)` : `NO CONTENT in ${ms}ms — first chunk: ${firstChunk}`;
      }
    } catch (err) {
      outcome = `FETCH FAILED: ${String(err?.message ?? err).slice(0, 120)}`;
    }
    const mark = outcome.startsWith("OK") ? "✓" : "✗";
    console.log(`${mark} ${m.provider.padEnd(11)} ${m.id.padEnd(58)} ${outcome}`);
    results.push({ id: m.id, provider: m.provider, outcome });
    // stay under the app's own per-minute burst limit (10 req/min)
    await new Promise((r) => setTimeout(r, 7_000));
  }

  const ok = results.filter((r) => r.outcome.startsWith("OK")).length;
  console.log(`\nSUMMARY: ${ok}/${results.length} models produced visible chat output through /api/chat`);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
