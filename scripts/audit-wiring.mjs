// audit-wiring.mjs — Static API wiring audit for CI.
//
// Cross-checks two directions:
//   1. Every "/api/..." reference in source (fetch, templates, window.open,
//      docs-in-comments, MCP server, …) must point at a route that exists
//      under src/app/api. A reference to a nonexistent route is almost always
//      a typo or an endpoint that was renamed away — exit 1.
//   2. Routes nothing references are printed as informational (many are
//      intentionally external: /api/auth/*, /api/mcp, admin/debug tools).
//      Pass --strict to fail on those too.
//
// Matching notes:
//   - Dynamic segments: src/app/api/agent/runs/[id]/route.ts →
//     /api/agent/runs/* — template refs like `/api/agent/runs/${id}` and
//     bracket docs like "/api/agent/runs/[id]/export/verify" normalize to the
//     same shape.
//   - Query strings are stripped: fetch("/api/settings/keys?id=${id}") and
//     fetch(`/api/agent/runs?${params}`) match their path routes.
//   - No dependencies: glob allowlist uses a tiny built-in matcher.
//
// Usage: node scripts/audit-wiring.mjs [--strict]
// Exit codes: 0 = pass, 1 = broken references (or --strict unreferenced),
//             2 = no routes discovered (broken checkout/setup).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "src", "app", "api");
const SCAN_DIRS = ["src", "scripts", "electron"].map((d) => path.join(ROOT, d));
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_PARTS = new Set(["node_modules", ".next", "coverage", ".git", ".docusaurus", "build", "dist"]);

// References to routes that do not exist on purpose. Files are glob patterns
// relative to the repo root (eval fixtures define mock endpoints for agent
// tasks — the agent is supposed to create those routes); refs are exact.
const REF_ALLOWLIST_FILES = ["src/lib/eval/**"];
// api-base.test.ts exercises the fetch-seam with deliberately fake routes
// (they assert URL construction, never a real handler). proxy-mcp-local.test.ts
// feeds the proxy deliberately fake leaf paths too: what it asserts is that
// /api/mcp/* never gets rewritten and that non-MCP paths always do — the
// handlers behind those fixtures don't exist by design.
const REF_ALLOWLIST = new Set([
  "/api/ping",
  "/api/x",
  "/api/agent/mcp-tools-backup",
  "/api/mcpx",
  "/api/mcp/connections/supabase/disconnect",
]);

const strict = process.argv.includes("--strict");

// ── helpers ──────────────────────────────────────────────────────────────

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP_PARTS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// "/api/a/[id]/b" becomes "/api/a/STAR/b" (STAR = literal * segment);
// a catch-all [...slug] becomes GLOB-GLOB-GLOB (GLOB = swallows the rest),
// because /api/auth/[...nextauth] really does own every depth beneath it;
// also used to normalize bracket-style doc references like "/api/agent/runs/[id]/export".
function normalizeDynamicSegments(p) {
  return p
    .replace(/\[\.{3}([^\]]+)\]/g, "**")
    .replace(/\[([^\]]+)\]/g, "*")
    .replace(/\/+$/, "")
    .replace(/\*\/+\*/g, "*");
}

/** Collapse template interpolation, strip the query string. */
function normalizeRef(raw) {
  const p = raw.replace(/\$\{[^}]*\}/g, "*");
  const q = p.indexOf("?");
  return normalizeDynamicSegments(q >= 0 ? p.slice(0, q) : p);
}

/**
 * Does a (normalized) reference point at a (normalized) route pattern?
 *
 * Three shapes have to work:
 *   - exact / same-depth dynamic: /api/agent/runs/r1 → /api/agent/runs/*
 *   - catch-all routes:           /api/auth/callback/google → /api/auth/**
 *     (a `**` segment owns every remaining depth, as long as ≥1 segment is left)
 *   - subtree prefix refs:        "/api/auth/" (a proxy rewrite constant) →
 *     any route under /api/auth/… — handled by refCoversRoute below.
 */
function refMatchesRoute(ref, route) {
  const a = ref.split("/");
  const b = route.split("/");
  for (let i = 0; i < b.length; i++) {
    if (b[i] === "**") return a.length > i; // [...catch-all] needs ≥1 segment left
    if (i >= a.length) return false;
    if (a[i] !== b[i] && b[i] !== "*") return false;
  }
  return a.length === b.length;
}

/** ref → route, allowing a reference to name a whole subtree of routes. */
function refCoversRoute(ref, route) {
  return refMatchesRoute(ref, route) || route.startsWith(`${ref}/`);
}

/** Tiny glob: ** crosses directories, * does not. */
function globToRegExp(glob) {
  const re = glob
    .split("**")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`);
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

// ── discover routes ──────────────────────────────────────────────────────

const routeFiles = walk(API_DIR).filter((f) => /^route\.(ts|js)$/.test(path.basename(f)));
if (routeFiles.length === 0) {
  console.error("✗ No API routes found under src/app/api — is this the right repo root?");
  process.exit(2);
}

const routes = new Map(); // pattern → file
for (const f of routeFiles) {
  const pattern = normalizeDynamicSegments(rel(f).replace(/^src\/app/, "").replace(/\/route\.(ts|js)$/, ""));
  routes.set(pattern, rel(f));
}

// ── collect every /api/... reference in source ───────────────────────────

// Anchored on a quote/backtick — or a closing brace, so template-suffixed
// calls like ctxFetch(`${base}/api/agent/grep`) are captured too.
const refRegex = /["'`}]\/api\/[a-zA-Z0-9/_\-.${\}\[\]?=&]*["'`]/g;
const refs = new Map(); // normalized ref → [{ file, line, raw }]
const allowlistRegexes = REF_ALLOWLIST_FILES.map(globToRegExp);

for (const dir of SCAN_DIRS) {
  for (const f of walk(dir)) {
    if (!CODE_EXTS.has(path.extname(f))) continue;
    const file = rel(f);
    // Skip this script — its own doc comments mention /api/ paths as examples.
    if (file === "scripts/audit-wiring.mjs") continue;
    const src = fs.readFileSync(f, "utf8");
    let m;
    refRegex.lastIndex = 0;
    while ((m = refRegex.exec(src))) {
      const raw = m[0].slice(1, -1);
      const ref = normalizeRef(raw);
      if (ref === "/api") continue;
      const line = src.slice(0, m.index).split("\n").length;
      if (!refs.has(ref)) refs.set(ref, []);
      refs.get(ref).push({ file, line, raw });
    }
  }
}

// ── direction 1: references → routes ────────────────────────────────────

const broken = [];
const allowed = [];
const matched = [];

for (const [ref, locs] of [...refs.entries()].sort()) {
  if ([...routes.keys()].some((route) => refCoversRoute(ref, route))) {
    matched.push(ref);
    continue;
  }
  const allowlisted =
    REF_ALLOWLIST.has(ref) || locs.every((l) => allowlistRegexes.some((re) => re.test(l.file)));
  (allowlisted ? allowed : broken).push({ ref, locs });
}

// ── direction 2: routes → references ────────────────────────────────────

const referencedRoutes = [...routes.keys()].filter((route) =>
  [...refs.keys()].some((ref) => refCoversRoute(ref, route)),
);
const unreferenced = [...routes.keys()].filter((r) => !referencedRoutes.includes(r)).sort();

// ── report ───────────────────────────────────────────────────────────────

console.log(`API wiring audit — ${routes.size} routes, ${refs.size} distinct references\n`);

if (broken.length > 0) {
  console.error("✗ References to nonexistent API routes:");
  for (const { ref, locs } of broken) {
    console.error(`  ${ref}`);
    for (const l of locs.slice(0, 3)) console.error(`      at ${l.file}:${l.line}`);
    if (locs.length > 3) console.error(`      … and ${locs.length - 3} more`);
  }
  console.error("\n  Fix the path, restore the route, or add an allowlist entry");
  console.error("  in scripts/audit-wiring.mjs if the endpoint is defined elsewhere.");
}

if (allowed.length > 0) {
  console.log(`• ${allowed.length} reference(s) allowlisted (mock/fixture endpoints):`);
  for (const { ref, locs } of allowed) console.log(`  ${ref}  (${locs[0].file})`);
}

const strictViolations = strict ? unreferenced : [];
if (strictViolations.length > 0) {
  console.error("\n✗ Routes nothing references (--strict):");
  for (const r of strictViolations) console.error(`  ${r}`);
}

console.log(`\n✓ ${matched.length} wired reference(s) · ${referencedRoutes.length}/${routes.size} routes referenced`);
if (unreferenced.length > 0) {
  console.log(`• ${unreferenced.length} route(s) with no in-repo reference (external/manual use):`);
  console.log(`  ${unreferenced.join("\n  ")}`);
}

const failed = broken.length > 0 || strictViolations.length > 0;
console.log(failed ? "\n✗ Wiring audit FAILED" : "\n✓ Wiring audit passed");
process.exit(failed ? 1 : 0);
