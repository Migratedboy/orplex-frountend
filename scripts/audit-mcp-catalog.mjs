// audit-mcp-catalog.mjs — Phase 6 catalog audit: probe every candidate and
// publish docs/MCP-CATALOG-AUDIT.md.
//
// The catalog header's contract: "Remote URLs are NEVER trusted from this
// file — Phase 6 probes each candidate and only verified endpoints ship as
// `remote`." This script is that phase, in two halves:
//
//   1. STATIC (always, deterministic): re-runs the Zod validation, then
//      policy checks the schema can't express — https-or-loopback on every
//      remote candidate (mirrors src/lib/mcp/ssrf-fetch.ts via the compiled
//      checkMcpUrl, no duplicated policy), shell metacharacters in stdio
//      command/args, auth-hint invariants, docsUrl scheme, duplicate ids,
//      category coverage, OAuth-by-default observations.
//
//   2. PROBES (skipped with --offline): POST an MCP `initialize` to every
//      remote candidate (remote.spec URLs ship only if verified — those are
//      the hard gate; mcp-remote stdio-arg URLs warn on failure because the
//      Connectors panel's listTools probe is their backstop), and check every
//      stdio package against the npm / PyPI registry for drift.
//
// The catalog module is TypeScript, so the script compiles it (plus
// ssrf-fetch.ts for the shared URL policy) with the repo's own tsc into
// node_modules/.cache and requires the result — no extra dependencies, no
// regex-scraping the source.
//
// Usage: node scripts/audit-mcp-catalog.mjs [--offline] [--strict]
//   --offline  skip network probes (static checks + report only)
//   --strict   treat warnings (package drift, unreachable stdio-arg URLs)
//              as failures
// Exit codes: 0 = pass, 1 = findings over threshold, 2 = setup failure.

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "orplex-mcp-audit");
const REPORT = path.join(ROOT, "docs", "MCP-CATALOG-AUDIT.md");
const SOURCES = [
  path.join(ROOT, "src", "lib", "mcp-catalog.ts"),
  path.join(ROOT, "src", "lib", "mcp", "ssrf-fetch.ts"),
];

const OFFLINE = process.argv.includes("--offline");
const STRICT = process.argv.includes("--strict");
const PROBE_TIMEOUT_MS = 10_000;
const POOL_LIMIT = 6;

// ── compile + load ──────────────────────────────────────────────────────────

function compile() {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error("typescript not installed — run npm install");
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        ...SOURCES,
        "--outDir", CACHE,
        "--module", "commonjs",
        "--target", "es2020",
        "--esModuleInterop",
        "--skipLibCheck",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = (e.stderr || "").toString().trim();
    throw new Error(`tsc compile failed:\n${err || e.message}`);
  }
  const req = createRequire(import.meta.url);
  const catalog = req(path.join(CACHE, "mcp-catalog.js"));
  const ssrf = req(path.join(CACHE, "mcp", "ssrf-fetch.js"));
  if (!Array.isArray(catalog.MCP_CATALOG) || typeof ssrf.checkMcpUrl !== "function") {
    throw new Error("compiled modules missing expected exports");
  }
  return { ...catalog, checkMcpUrl: ssrf.checkMcpUrl, isLoopbackHost: ssrf.isLoopbackHost };
}

// ── extraction ──────────────────────────────────────────────────────────────

/** Remote candidates: explicit remote.spec URLs + http(s) stdio args (mcp-remote style). */
function collectCandidates(entries) {
  const out = [];
  const seen = new Set();
  const push = (e, url, via) => {
    const key = `${e.id}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: e.id, url, via });
  };
  for (const e of entries) {
    if (e.remote?.url) push(e, e.remote.url, "remote.spec");
    for (const a of e.stdio?.args ?? []) {
      if (/^https?:\/\//.test(a)) push(e, a, "stdio-arg");
    }
  }
  return out;
}

/** stdio package (npx → first non-flag arg, uvx → first arg) for registry probes. */
function collectPackages(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const { command, args = [] } = e.stdio ?? {};
    let pkg = null;
    if (command === "npx") {
      pkg = args.find((a) => !a.startsWith("-") && !/^https?:\/\//.test(a)) ?? null;
    } else if (command === "uvx") {
      pkg = args[0] ?? null;
    }
    if (!pkg) {
      out.push({ id: e.id, command, pkg: null, registry: null });
      continue;
    }
    const key = `${command}:${pkg}`;
    const registry = command === "uvx" ? "pypi" : "npm";
    if (!seen.has(key)) seen.add(key);
    out.push({ id: e.id, command, pkg, registry });
  }
  return out;
}

// ── static checks ───────────────────────────────────────────────────────────

// Shell metacharacters that matter if a launcher ever spawns with a shell.
// `<`/`>` are excluded on purpose: placeholder args like `--project-ref=<ref>`
// and `/absolute/path/to/folder` are template text, and spawn(command, args)
// runs without a shell.
const SHELL_META = /[;|&`\n\r$]/;

function staticChecks(mod, entries, candidates) {
  const errors = [];
  const warnings = [];
  const info = [];

  const v = mod.validateMcpCatalog(entries);
  if (!v.ok) for (const e of v.errors) errors.push(`schema: ${e}`);

  const ids = new Map();
  const names = new Map();
  for (const e of entries) {
    ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
    const nk = e.name.toLowerCase();
    names.set(nk, (names.get(nk) ?? 0) + 1);
    const label = `${e.id}`;

    // Per-entry parse for precise messages (array parse only reports indices).
    const p = mod.mcpCatalogEntrySchema.safeParse(e);
    if (!p.success) {
      for (const issue of p.error.issues) {
        errors.push(`${label}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }

    // Auth invariants (mirrors src/lib/__tests__/mcp-catalog.test.ts).
    const hasSecret = (e.stdio?.env ?? []).some((s) => s.secret);
    if (e.auth === "oauth" && !e.oauth) errors.push(`${label}: auth=oauth without oauth spec`);
    if (e.oauth && e.auth !== "oauth") errors.push(`${label}: oauth spec present but auth=${e.auth}`);
    if (e.auth === "token" && !hasSecret) errors.push(`${label}: auth=token but no secret env`);
    if (e.auth === "none" && hasSecret) errors.push(`${label}: auth=none but a secret env exists`);
    if (e.auth === "none" && (e.stdio?.args ?? []).some((a) => /^https?:\/\//.test(a))) {
      warnings.push(
        `${label}: remote endpoint via mcp-remote but auth=none — OAuth-by-default expects an oauth hint (see docs/MCP-OAUTH.md §4)`,
      );
    }

    // stdio command/args safety — catalog data must never smuggle shell syntax.
    if (e.stdio) {
      if (!["npx", "uvx"].includes(e.stdio.command)) {
        warnings.push(`${label}: command "${e.stdio.command}" outside npx/uvx allowlist`);
      }
      const all = [e.stdio.command, ...(e.stdio.args ?? [])];
      for (const s of all) {
        if (SHELL_META.test(String(s))) {
          errors.push(`${label}: shell metacharacter in stdio command/args: ${JSON.stringify(s)}`);
        }
      }
    }

    if (e.docsUrl) {
      try {
        const u = new URL(e.docsUrl);
        if (u.protocol !== "https:") errors.push(`${label}: docsUrl must be https (${e.docsUrl})`);
      } catch {
        errors.push(`${label}: docsUrl unparseable (${e.docsUrl})`);
      }
    }
  }

  for (const [id, n] of ids) if (n > 1) errors.push(`duplicate id "${id}" (${n}x)`);
  for (const [name, n] of names) if (n > 1) errors.push(`duplicate name "${name}" (${n}x)`);

  // URL policy — same checkMcpUrl the transport fetch uses (C7).
  for (const c of candidates) {
    const verdict = mod.checkMcpUrl(c.url);
    if (!verdict.allowed) {
      errors.push(`${c.id}: remote candidate violates URL policy — ${c.url} (${verdict.reason})`);
    }
  }

  // Category coverage.
  const used = new Set(entries.map((e) => e.category));
  const declared = mod.MCP_CATEGORIES.filter((c) => c.key !== "all").map((c) => c.key);
  for (const k of declared) if (!used.has(k)) warnings.push(`category "${k}" has no entries`);
  for (const k of used) {
    if (!declared.includes(k)) errors.push(`entry category "${k}" missing from MCP_CATEGORIES`);
  }

  const oauthByDefault = entries.filter(
    (e) => e.auth === "none" && (e.stdio?.args ?? []).some((a) => /^https?:\/\//.test(a)),
  ).length;
  if (oauthByDefault > 0) {
    info.push(`${oauthByDefault} mcp-remote entries carry auth=none (OAuth happens inside mcp-remote)`);
  }

  return { errors, warnings, info };
}

// ── probes ──────────────────────────────────────────────────────────────────

async function readBodyLimited(res, maxChars = 8192) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (buf.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("\n\n")) break;
    }
  } finally {
    try {
      await res.body.cancel();
    } catch {}
  }
  return buf;
}

// Network errors worth one more attempt (DNS blips, resets, timeouts).
const TRANSIENT = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR|socket hang up/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** npm name without a version spec: `pkg@1.2.3` / `@s/p@latest` → `pkg` / `@s/p`. */
function npmName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const at = spec.lastIndexOf("@");
    return at > slash ? spec.slice(0, at) : spec;
  }
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** MCP probe for one remote candidate. Verdicts: verified | auth-gated | not-mcp | unreachable. */
async function probeRemote(c) {
  const t0 = Date.now();
  const base = { ...c, ms: 0, detail: "" };
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orplex-catalog-audit", version: "1.0" },
    },
  });
  const send = (accept) =>
    c.transport === "sse"
      ? fetch(c.url, { method: "GET", headers: { accept }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      : fetch(c.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept },
          body: initBody,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });

  let lastFailure = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700);
    const accept = attempt === 0 ? "application/json, text/event-stream" : "*/*";
    let res;
    try {
      res = await send(accept);
    } catch (e) {
      const reason =
        e?.name === "TimeoutError" || e?.name === "AbortError"
          ? `timeout after ${PROBE_TIMEOUT_MS}ms`
          : String(e?.cause?.code || e?.cause?.message || e?.message || e);
      lastFailure = reason;
      if (e?.name === "TimeoutError" || TRANSIENT.test(reason)) continue;
      break;
    }
    base.ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      const www = res.headers.get("www-authenticate") || "";
      await readBodyLimited(res).catch(() => "");
      return {
        ...base,
        verdict: "auth-gated",
        status: res.status,
        detail: www ? `WWW-Authenticate: ${www.slice(0, 120)}` : "credentials required before initialize",
      };
    }
    // A retry with Accept: */* can turn 405/406/415 (header fussiness) into a verdict.
    if ([405, 406, 415].includes(res.status) && attempt < 2) {
      await readBodyLimited(res).catch(() => "");
      continue;
    }
    const body = await readBodyLimited(res);
    if ((res.status === 200 || res.status === 400) && /"jsonrpc"|json-rpc/i.test(body)) {
      const ver = body.match(/"protocolVersion"\s*:\s*"([^"]+)"/);
      return {
        ...base,
        verdict: "verified",
        status: res.status,
        detail: ver ? `protocol ${ver[1]}` : res.status === 400 ? "jsonrpc error (MCP-speaking)" : "jsonrpc response",
      };
    }
    if (res.status >= 200 && res.status < 300) {
      const head = body.replace(/\s+/g, " ").slice(0, 120);
      return { ...base, verdict: "not-mcp", status: res.status, detail: `200 but not MCP — "${head}"` };
    }
    return { ...base, verdict: "unreachable", status: res.status, detail: `HTTP ${res.status}` };
  }
  return { ...base, verdict: "unreachable", status: null, ms: Date.now() - t0, detail: lastFailure ?? "gave up" };
}

async function probePackage(p) {
  const t0 = Date.now();
  const base = { ...p, ms: 0, version: "", published: "", detail: "" };
  const name = p.registry === "npm" ? npmName(p.pkg) : p.pkg;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(700);
    try {
      if (p.registry === "pypi") {
        const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        base.ms = Date.now() - t0;
        if (res.status === 404) return { ...base, verdict: "missing", detail: "404 on PyPI" };
        if (!res.ok) return { ...base, verdict: "error", detail: `HTTP ${res.status}` };
        const j = await res.json();
        return { ...base, verdict: "ok", version: j?.info?.version ?? "", detail: "PyPI" };
      }
      const enc = name.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`https://registry.npmjs.org/${enc}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      base.ms = Date.now() - t0;
      if (res.status === 404) return { ...base, verdict: "missing", detail: "404 on npm" };
      if (!res.ok) return { ...base, verdict: "error", detail: `HTTP ${res.status}` };
      const j = await res.json();
      const latest = j?.["dist-tags"]?.latest ?? "";
      if (!latest) {
        // Metadata shell left behind after unpublish — nothing installable.
        return { ...base, verdict: "dead", detail: "metadata present, no dist-tags (unpublished?)" };
      }
      const version = j.versions?.[latest] ?? null;
      const published = (j.time?.[latest] ?? "").slice(0, 10);
      if (version?.deprecated) {
        return { ...base, verdict: "deprecated", version: latest, published, detail: String(version.deprecated).slice(0, 120) };
      }
      return { ...base, verdict: "ok", version: latest, published, detail: "npm" };
    } catch (e) {
      base.ms = Date.now() - t0;
      const reason = e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code || e?.message || e);
      if (attempt === 0 && (e?.name === "TimeoutError" || TRANSIENT.test(reason))) continue;
      return { ...base, verdict: "error", detail: reason };
    }
  }
  return { ...base, verdict: "error", detail: "gave up", ms: Date.now() - t0 };
}

async function probeDocs(d) {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(700);
    try {
      const res = await fetch(d.docsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "follow",
      });
      try {
        await res.body?.cancel();
      } catch {}
      return { ...d, status: res.status, ms: Date.now() - t0, ok: res.ok };
    } catch (e) {
      const reason = e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code || e?.message || e);
      if (attempt === 0 && (e?.name === "TimeoutError" || TRANSIENT.test(reason))) continue;
      return { ...d, status: null, ms: Date.now() - t0, ok: false, detail: reason };
    }
  }
  return { ...d, status: null, ms: Date.now() - t0, ok: false, detail: "gave up" };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────

const OK = (v) => (v ? "✅" : "❌");

function buildReport({ mod, entries, candidates, packages, stat, probes, generatedAt }) {
  const lines = [];
  const remoteRows = probes?.remotes ?? [];
  const pkgRows = probes?.packages ?? [];
  const docsRows = probes?.docs ?? [];

  const verified = remoteRows.filter((r) => r.verdict === "verified" || r.verdict === "auth-gated").length;
  const pkgOk = pkgRows.filter((r) => r.verdict === "ok").length;

  lines.push("# MCP catalog audit");
  lines.push("");
  lines.push(
    `Generated by \`npm run audit:mcp\` (\`scripts/audit-mcp-catalog.mjs\`) on ${generatedAt}` +
      (OFFLINE ? " — **offline run, probes skipped**" : "") + ".",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **${entries.length}** catalog entries — ${mod.MCP_CATEGORIES.length - 1} categories.`);
  lines.push(`- **${candidates.length}** remote candidates (${candidates.filter((c) => c.via === "remote.spec").length} remote.spec, ${candidates.filter((c) => c.via === "stdio-arg").length} stdio-arg / mcp-remote).`);
  lines.push(`- **${packages.length}** stdio package references (${new Set(packages.map((p) => p.registry ?? "manual")).size} registries in play).`);
  lines.push(`- Static checks: ${stat.errors.length ? `**${stat.errors.length} error(s)**` : "**PASS**"} — ${stat.warnings.length} warning(s).`);
  if (OFFLINE) {
    lines.push("- Probes: skipped (`--offline`).");
  } else {
    lines.push(`- Remote probes: **${verified}/${remoteRows.length}** reachable (verified or auth-gated).`);
    lines.push(`- Package probes: **${pkgOk}/${pkgRows.length}** found${pkgRows.filter((p) => p.verdict === "missing").length ? `, ${pkgRows.filter((p) => p.verdict === "missing").length} MISSING` : ""}.`);
  }
  if (stat.info.length) {
    for (const i of stat.info) lines.push(`- Note: ${i}`);
  }
  lines.push("");

  lines.push("## Static checks");
  lines.push("");
  if (stat.errors.length === 0 && stat.warnings.length === 0) {
    lines.push("All checks passed (schema, auth invariants, https-or-loopback URL policy, stdio command safety, docsUrl scheme, duplicate ids/names, category coverage).");
  } else {
    for (const e of stat.errors) lines.push(`- ❌ ${e}`);
    for (const w of stat.warnings) lines.push(`- ⚠️ ${w}`);
  }
  lines.push("");

  lines.push("## Remote endpoint probes");
  lines.push("");
  if (OFFLINE) {
    lines.push("_Skipped — rerun without `--offline` to probe._");
  } else {
    lines.push("Every remote candidate gets an MCP `initialize` POST (SSE GET for `transport: sse`). `remote.spec` failures are hard failures (only verified endpoints ship as `remote`); mcp-remote stdio-arg failures warn — the Connectors panel's live `listTools` probe is their backstop.");
    lines.push("");
    lines.push("| entry | url | via | verdict | status | ms | detail |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of remoteRows) {
      const mark = r.verdict === "verified" ? "✅ verified" : r.verdict === "auth-gated" ? "✅ auth-gated" : `❌ ${r.verdict}`;
      lines.push(`| ${r.id} | ${r.url} | ${r.via} | ${mark} | ${r.status ?? "—"} | ${r.ms} | ${r.detail} |`);
    }
  }
  lines.push("");

  lines.push("## stdio package probes");
  lines.push("");
  if (OFFLINE) {
    lines.push("_Skipped — rerun without `--offline` to probe._");
  } else {
    lines.push("Registry existence check (npm / PyPI) — catches package drift before a user's first connect. `missing`/`dead` (no installable version) and other non-ok verdicts fail under `--strict`.");
    lines.push("");
    lines.push("| entry | command | package | registry | verdict | version | published |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const p of pkgRows) {
      if (!p.pkg) {
        lines.push(`| ${p.id} | ${p.command} | — | — | ⚠️ manual | — | — |`);
        continue;
      }
      const mark = p.verdict === "ok" ? "✅" : p.verdict === "deprecated" ? "⚠️" : "❌";
      lines.push(`| ${p.id} | ${p.command} | \`${p.pkg}\` | ${p.registry} | ${mark} ${p.verdict} | ${p.version || "—"} | ${p.published || "—"} |`);
    }
  }
  lines.push("");

  const withDocs = entries.filter((e) => e.docsUrl);
  lines.push("## Docs links");
  lines.push("");
  if (withDocs.length === 0) {
    lines.push("_No docsUrl entries._");
  } else if (OFFLINE) {
    lines.push(`_Skipped — ${withDocs.length} docsUrl entries._`);
  } else {
    lines.push("| entry | docsUrl | status | ms |");
    lines.push("|---|---|---|---|");
    for (const d of docsRows) lines.push(`| ${d.id} | ${d.docsUrl} | ${d.ok ? "✅" : "❌"} ${d.status ?? d.detail ?? ""} | ${d.ms} |`);
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push("- The probe is intentionally shallow: it proves the endpoint speaks MCP (or demands auth) and that packages exist — it does not enumerate tools. The Connectors panel's test-connection (`listTools`) is the deep check.");
  lines.push("- OAuth for the `mcp-remote` stdio proxies runs inside `@anthropic-ai/mcp-remote`; those entries carry an `oauth: {}` hint so the panel prompts for a browser sign-in, and the audit's `auth=none` + http(s)-arg warning no longer fires (no `remote`, so the stdio env form and Save stay visible).");
  lines.push("- Living spec: `docs/MCP-OAUTH.md` §8.");
  lines.push("");
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  let mod;
  try {
    mod = compile();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }

  const entries = mod.MCP_CATALOG;
  const candidates = collectCandidates(entries);
  const packages = collectPackages(entries);
  const stat = staticChecks(mod, entries, candidates);

  let probes = null;
  if (!OFFLINE) {
    const docTargets = entries
      .filter((e) => e.docsUrl)
      .map((e) => ({ id: e.id, docsUrl: e.docsUrl }));
    const [remotes, pkgs, docs] = await Promise.all([
      pool(candidates, POOL_LIMIT, probeRemote),
      pool(packages, POOL_LIMIT, probePackage),
      pool(docTargets, POOL_LIMIT, probeDocs),
    ]);
    probes = { remotes, packages: pkgs, docs };
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const report = buildReport({ mod, entries, candidates, packages, stat, probes, generatedAt });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, report, "utf8");

  // ── console summary ──
  console.log(`MCP catalog audit — ${entries.length} entries, ${candidates.length} remote candidates, ${packages.length} package references\n`);

  if (stat.errors.length > 0) {
    console.error(`✗ ${stat.errors.length} static error(s):`);
    for (const e of stat.errors) console.error(`  ${e}`);
  }
  if (stat.warnings.length > 0) {
    console.log(`⚠ ${stat.warnings.length} warning(s):`);
    for (const w of stat.warnings) console.log(`  ${w}`);
  }

  let probeFailures = 0;
  let strictWarnings = stat.warnings.length;
  if (probes) {
    const badRemotes = probes.remotes.filter((r) => r.verdict !== "verified" && r.verdict !== "auth-gated");
    for (const r of badRemotes) {
      const hard = r.via === "remote.spec";
      const line = `${r.id}: ${r.verdict} — ${r.url} (${r.detail})`;
      if (hard) {
        console.error(`✗ ${line}`);
        probeFailures++;
      } else {
        console.log(`⚠ ${line}`);
        strictWarnings++;
      }
    }
    const badPkgs = probes.packages.filter((p) => p.verdict !== "ok");
    for (const p of badPkgs) {
      const line = p.pkg
        ? `${p.id}: package "${p.pkg}" ${p.verdict} on ${p.registry} (${p.detail})`
        : `${p.id}: non-npx/uvx command "${p.command}" — manual check`;
      console.log(`⚠ ${line}`);
      strictWarnings++;
    }
    const badDocs = probes.docs.filter((d) => !d.ok);
    for (const d of badDocs) console.log(`⚠ ${d.id}: docsUrl ${d.status ?? d.detail} — ${d.docsUrl}`);
    console.log(`\nProbes: ${probes.remotes.length - badRemotes.length}/${probes.remotes.length} remote ok, ${probes.packages.length - badPkgs.length}/${probes.packages.length} packages ok, ${probes.docs.length - badDocs.length}/${probes.docs.length} docs ok`);
  } else {
    console.log("\nProbes skipped (--offline)");
  }

  console.log(`Report: ${path.relative(ROOT, REPORT)}`);

  const failed = stat.errors.length > 0 || probeFailures > 0 || (STRICT && strictWarnings > 0);
  console.log(failed ? "\n✗ MCP catalog audit FAILED" : "\n✓ MCP catalog audit passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`✗ audit crashed: ${e?.stack || e}`);
  process.exit(2);
});
