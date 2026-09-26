// fetch-fonts.mjs — downloads self-hosted font subsets and regenerates the
// @font-face CSS for BOTH sites that share the brand typography:
//   - the Next.js app   (public/fonts + src/app/fonts.css)
//   - the Docusaurus docs-site (docs-site/static/fonts + docs-site/src/css/fonts.css)
// Both serve the files from /fonts/, so the generated CSS is byte-identical
// across targets and a re-run keeps product + docs in sync automatically.
//
// The docs-site build calls this script automatically (its package.json
// "prebuild" hook), so shipping docs always refreshes the latest faces with
// no manual regeneration. The app re-runs it only when fonts change.
//
// Self-hosting keeps the designed fonts (Lexend + JetBrains Mono) working
// under the app's CSP (font-src 'self' data:) without a runtime dependency on
// Google Fonts. Normal AND italic faces are fetched for every weight so
// markdown italics/emphasis render with a real italic face instead of the
// browser's synthetic slant (where the foundry ships one — see below).
//
// The two targets (where woff2 files + fonts.css go per site) are defined in
// ./font-targets.mjs and shared with scripts/check-fonts-sync.mjs.
//
// Usage (any cwd — paths anchor to this file, so it works from npm lifecycle
// hooks in docs-site or from the repo root):
//     node scripts/fetch-fonts.mjs
// Only latin + latin-ext subsets are kept (the UI language); re-run whenever
// you want to add weights, styles, or refresh the subset files.
//
// Network resilience: if fonts.googleapis.com is unreachable (offline build,
// locked-down CI) the script keeps whatever is already on disk in both
// targets and exits 0, so a docs build never fails because of fonts. Set
// ORPLEX_FONTS_SKIP_NETWORK=1 to force that path without even trying the
// network (guaranteed-offline builds).
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TARGETS } from "./font-targets.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);

// Families, weights, and styles to fetch. font-style pairs are emitted in
// css2's axis syntax (ital,wght@0,400;1,400;…) — 0 = normal, 1 = italic.
//
// Weights/styles mirror what the app's CSS actually references (checked
// against src/app/globals.css + component classes; the docs-site inherits the
// same faces via Infima variables):
//   - Lexend has NO italic axis on Google Fonts (a single Lexend[wght].ttf,
//     verified against google/fonts METADATA.pb) — only normal faces are
//     requested, and its emphasis keeps the browser's synthetic oblique.
//   - JetBrains Mono ships real italics; 600/800 are used by approval/board
//     badges (font-weight 600/800 in mono contexts), hence included.
const FONTS = [
  { family: "Lexend", weights: [400, 500, 600, 700], styles: ["normal"] },
  { family: "JetBrains Mono", weights: [400, 500, 600, 700, 800], styles: ["normal", "italic"] },
];

const CSS_URL =
  "https://fonts.googleapis.com/css2?" +
  FONTS.map((f) => {
    const axisPairs = [];
    for (const style of f.styles) {
      for (const weight of f.weights) {
        axisPairs.push(`${style === "italic" ? 1 : 0},${weight}`);
      }
    }
    return `family=${encodeURIComponent(f.family)}:ital,wght@${axisPairs.join(";")}`;
  }).join("&") +
  "&display=swap";

const SKIP_NETWORK = process.env.ORPLEX_FONTS_SKIP_NETWORK === "1";

function slug(family, subset, style, weight) {
  return `${family.replace(/\s+/g, "").toLowerCase()}-${subset}-${style}-${weight}.woff2`;
}

// Do all targets already carry woff2 files + their generated css? Used to
// degrade gracefully when the network fetch fails mid-build.
async function existingAssetsComplete() {
  for (const target of TARGETS) {
    const haveDir = await readdir(target.fontsDir).catch(() => null);
    if (!haveDir || !haveDir.some((f) => f.endsWith(".woff2"))) return false;
    if (!(await readdir(dirname(target.cssOut)).then((d) => d.includes("fonts.css")).catch(() => false))) return false;
  }
  return true;
}

// Per-file download lines are verbose for npm lifecycle hooks (predev /
// prebuild fire the fetcher on every dev/build run), so only print them when
// stdout is an interactive terminal. Warnings/errors and the summary lines
// always print.
const TTY = Boolean(process.stdout.isTTY);
const logDetail = TTY ? console.log : () => {};

// Bound the network wait so an offline `npm run dev`/`npm run build` start
// degrades to the keep-existing-files fallback quickly instead of hanging on
// an unreachable host.
const CSS_TIMEOUT_MS = 8000;

async function fetchAll() {
  const css = await (await fetch(CSS_URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(CSS_TIMEOUT_MS) })).text();

  // css2 groups faces under "/* <subset> */" comments.
  const blocks = [...css.matchAll(/\/\* ([a-z-]+) \*\/\s*(\@font-face\s*\{[^}]*\})/g)].map((m) => ({
    subset: m[1],
    face: m[2],
  }));
  console.log(`parsed ${blocks.length} subset faces total`);

  // Warn when a requested style produced no faces (e.g. Lexend italic — the
  // family genuinely lacks the axis) so silent gaps aren't mistaken for success.
  for (const f of FONTS) {
    for (const style of f.styles) {
      const got = blocks.some(({ face }) => face.includes(`font-style: ${style}`) && face.includes(`font-family: '${f.family}'`));
      if (!got) console.warn(`!! no ${style} faces returned for ${f.family} (source limitation, skipping)`);
    }
  }

  // Download every kept face once; the bytes are identical across targets.
  const faces = [];
  for (const { subset, face } of blocks) {
    if (!KEEP_SUBSETS.has(subset)) continue;
    const family = face.match(/font-family:\s*'([^']+)'/)?.[1];
    const style = face.match(/font-style:\s*(\w+)/)?.[1] || "normal";
    const weight = face.match(/font-weight:\s*(\d+)/)?.[1];
    const url = face.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!family || !weight || !url) {
      console.warn("skip block:", face.slice(0, 90).replace(/\s+/g, " "));
      continue;
    }
    const name = slug(family, subset, style, weight);
    const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(CSS_TIMEOUT_MS) })).arrayBuffer());
    faces.push({ name, family, style, weight, face: face.replace(/url\(https:[^)]+\)/, `url('/fonts/${name}')`), buf });
  }
  if (faces.length === 0) throw new Error("no faces parsed from the css2 response");

  const header = [
    "/* fonts.css — self-hosted Lexend + JetBrains Mono (latin, latin-ext).",
    " * Generated by scripts/fetch-fonts.mjs — re-run it to refresh or extend.",
    " * Emitted for the app (public/fonts + src/app/fonts.css) AND the docs-site",
    " * (docs-site/static/fonts + docs-site/src/css/fonts.css) so product and",
    " * docs share the same faces; both serve them from /fonts/. The docs-site",
    " * build refreshes these automatically via its package.json prebuild hook.",
    " * Real italic faces are included where the foundry ships them (JetBrains",
    " * Mono: 400-800 normal + italic). Google Fonts' Lexend has no italic axis",
    " * (Lexend[wght].ttf only), so Lexend emphasis keeps the browser's",
    " * synthetic oblique — a typeface limitation, not a code fix.",
    " * Self-hosting keeps the fonts working under the app's CSP",
    " * (font-src 'self' data:) with no Google Fonts runtime dependency (the",
    " * previous @import was CSP-blocked, so the designed fonts never loaded",
    " * and text fell back to system fonts).",
    " */",
    "",
  ];
  const cssBody = header.concat(faces.map((f) => f.face + "\n")).join("\n");

  for (const target of TARGETS) {
    await mkdir(target.fontsDir, { recursive: true });
    await mkdir(dirname(target.cssOut), { recursive: true });

    // Drop stale files from earlier runs (renames, removed weights) — only
    // after every download succeeded, so a failure never deletes the old set.
    const existing = (await readdir(target.fontsDir)).filter((f) => f.endsWith(".woff2"));
    const wanted = new Set(faces.map((f) => f.name));
    for (const stale of existing.filter((f) => !wanted.has(f))) {
      await rm(join(target.fontsDir, stale));
      console.log(`removed stale ${target.label}: ${stale}`);
    }

    for (const f of faces) {
      await writeFile(join(target.fontsDir, f.name), f.buf);
      logDetail(`saved ${target.label}: fonts/${f.name} (${(f.buf.byteLength / 1024).toFixed(1)} kB)`);
    }
    await writeFile(target.cssOut, cssBody);
    console.log(`wrote ${target.label}: ${target.cssOut} (${faces.length} faces)`);
  }
}

if (SKIP_NETWORK) {
  // Explicit offline mode (ORPLEX_FONTS_SKIP_NETWORK=1): never touch the
  // network; keep the committed fonts.
  if (await existingAssetsComplete()) {
    console.warn("ORPLEX_FONTS_SKIP_NETWORK=1 — keeping the fonts already on disk (no network fetch).");
    process.exit(0);
  }
  console.error("ORPLEX_FONTS_SKIP_NETWORK=1 but no fonts are on disk — nothing to ship. Run once with network access.");
  process.exit(1);
}

try {
  await fetchAll();
} catch (err) {
  // Network/build hiccup: prefer shipping the last good fonts over failing
  // the docs build. Only hard-fail when there is genuinely nothing on disk.
  if (await existingAssetsComplete()) {
    console.warn(`font fetch failed (${err.message}) — keeping the fonts already on disk; build continues.`);
    process.exit(0);
  }
  console.error("font fetch failed and no local fonts exist:", err);
  process.exit(1);
}
