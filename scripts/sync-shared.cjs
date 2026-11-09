/**
 * sync-shared.mjs — copy the shared lib set from `orplex` (source of truth)
 * into `orplex-backend` so the two repos never drift on model defaults,
 * provider routes, or the lean roster.
 *
 * RUN FROM D:/orplex repo root:  node scripts/sync-shared.mjs [--check]
 * [--check] exits 1 listing drift without writing.
 *
 * Shared = files whose contract must match byte-for-byte across the split:
 * provider plumbing, model defaults, token budget, tool roster.
 * Backend-only files (routes like /api/chat/fast, sandbox, migrate-from-cloud,
 * its executor) are NEVER listed here — they are hand-edited (Groq removal
 * touched them in place).
 */
"use strict";
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const CHECK = process.argv.includes("--check");
const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const DST = path.join(ROOT, "..", "orplex-backend", "src");

const SHARED = [
  // Verified byte-safe to copy: backend compiles + passes on these exact
  // frontend versions (checked 2026-11-09). Everything else intentionally
  // DIVERGES (backend has its own variants grown for the API-only split:
  // ai-providers, model-catalog, tool-definitions, quota-manager, executor,
  // chat route, token-budget — the backend does not even import it).
  // Those are hand-edited in both repos — never copy here.
  "lib/provider-registry.ts",
  "lib/model-router.ts",
  "lib/default-models.ts",
];

let drift = 0;
for (const rel of SHARED) {
  const srcFile = path.join(SRC, rel);
  const dstFile = path.join(DST, rel);
  let srcText;
  try {
    srcText = readFileSync(srcFile, "utf8");
  } catch {
    console.log(`SKIP ${rel} (not in frontend)`);
    continue;
  }
  try {
    const dstText = readFileSync(dstFile, "utf8");
    if (dstText === srcText) {
      console.log(`same ${rel}`);
      continue;
    }
    drift++;
    if (CHECK) {
      console.log(`DRIFT ${rel}`);
      continue;
    }
    mkdirSync(path.dirname(dstFile), { recursive: true });
    writeFileSync(dstFile, srcText, "utf8");
    console.log(`sync ${rel}`);
  } catch {
    drift++;
    if (CHECK) {
      console.log(`MISSING-in-backend ${rel}`);
      continue;
    }
    mkdirSync(path.dirname(dstFile), { recursive: true });
    writeFileSync(dstFile, srcText, "utf8");
    console.log(`created backend copy ${rel}`);
  }
}
if (CHECK && drift > 0) {
  console.log(`\n${drift} file(s) drifted. Run without --check to sync.`);
  process.exit(1);
}
console.log(CHECK ? "\nAll shared files in sync." : "\nSync complete.");
