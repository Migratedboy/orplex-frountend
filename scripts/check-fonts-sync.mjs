// check-fonts-sync.mjs — verifies the app and docs-site font targets are in
// lockstep and fails loudly (exit 1) if they drift:
//   - the woff2 file sets must match exactly (same names, same bytes)
//   - the generated fonts.css must be byte-identical in both sites
//
// The generator (scripts/fetch-fonts.mjs) writes both targets from the same
// downloaded bytes, so drift means one target was edited by hand, a partial
// write interrupted one side, or a file was renamed in only one place. Fix
// with:
//     node scripts/fetch-fonts.mjs
//
// Usage (any cwd):  node scripts/check-fonts-sync.mjs
// Wired up as `npm run check:fonts` in both the app (root) and docs-site.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TARGETS } from "./font-targets.mjs";

const [a, b] = TARGETS;

async function listWoff2(target) {
  return readdir(target.fontsDir)
    .catch(() => [])
    .then((files) => files.filter((f) => f.endsWith(".woff2")).sort());
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function cssBytes(target) {
  return readFile(target.cssOut).catch(() => null);
}

const problems = [];

// --- woff2 file sets: same names, same bytes --------------------------------
const aFiles = await listWoff2(a);
const bFiles = await listWoff2(b);
const aSet = new Set(aFiles);
const bSet = new Set(bFiles);

for (const name of aFiles) if (!bSet.has(name)) problems.push(`missing in ${b.label}: fonts/${name}`);
for (const name of bFiles) if (!aSet.has(name)) problems.push(`extra in ${b.label} (not in ${a.label}): fonts/${name}`);

for (const name of aFiles) {
  if (!bSet.has(name)) continue;
  const ha = await sha256(join(a.fontsDir, name));
  const hb = await sha256(join(b.fontsDir, name));
  if (ha !== hb) problems.push(`content differs: fonts/${name} (${a.label} ${ha.slice(0, 10)}… vs ${b.label} ${hb.slice(0, 10)}…)`);
}

// --- generated css must be byte-identical ------------------------------------
const cssA = await cssBytes(a);
const cssB = await cssBytes(b);
if (cssA === null || cssB === null) {
  problems.push(`fonts.css missing in ${cssA === null ? a.label : b.label} (${cssA === null ? a.cssOut : b.cssOut})`);
} else if (!cssA.equals(cssB)) {
  problems.push(`fonts.css differs between ${a.label} (${a.cssOut}) and ${b.label} (${b.cssOut})`);
}

if (problems.length > 0) {
  console.error("✗ FONT DRIFT DETECTED — the app and docs-site font targets disagree:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix: run `node scripts/fetch-fonts.mjs` to regenerate both targets from Google Fonts.");
  process.exit(1);
}

if (aFiles.length === 0 && bFiles.length === 0 && cssA === null && cssB === null) {
  console.warn("⚠ Both font targets are empty — nothing has been fetched yet. Run `node scripts/fetch-fonts.mjs` (or npm run predev/prebuild) to populate them.");
  process.exit(0);
}

console.log(`✓ Font targets in sync: ${aFiles.length} woff2 files identical across ${a.label} + ${b.label}, fonts.css byte-identical.`);
