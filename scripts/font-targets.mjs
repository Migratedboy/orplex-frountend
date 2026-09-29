// font-targets.mjs — single source of truth for where the shared brand fonts
// live. Imported by both scripts/fetch-fonts.mjs (generator) and
// scripts/check-fonts-sync.mjs (drift check) so the two can never disagree
// about the targets. Paths anchor to this file, so the scripts work from any
// cwd (npm lifecycle hooks run them from docs-site or the repo root).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Where each site keeps its fonts dir + generated CSS. The font-face src URLs
// are root-relative ('/fonts/…'), which both the app's public/ dir and
// Docusaurus' static/ dir serve from the site root.
export const TARGETS = [
  { label: "app",        fontsDir: join(ROOT, "public", "fonts"),            cssOut: join(ROOT, "src", "app", "fonts.css") },
  { label: "docs-site",  fontsDir: join(ROOT, "docs-site", "static", "fonts"), cssOut: join(ROOT, "docs-site", "src", "css", "fonts.css") },
];

// Hand-maintained (non-generated) faces vendored into the repo instead of
// downloaded from Google Fonts. Each subdirectory of assets/fonts/ carries
// font files + a hand-written fonts.css (@font-face block). The generator
// copies every font file into each target's fontsDir and appends the
// @font-face block below the generated section of each fonts.css; the drift
// check covers them like any other face, so they can't silently differ
// between the two sites.
//
// Vendored families: newsreader (text serif, 2026-09), fraunces (display
// serif, 2026-09), material-symbols (icon font, 2026-09).
import { readdirSync } from "node:fs";

export const VENDORED_FONT_DIRS = readdirSync(join(ROOT, "assets", "fonts"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(ROOT, "assets", "fonts", d.name))
  .sort();

// Back-compat single-dir export no longer used by the generator; kept so any
// stray import fails loudly at startup rather than silently skipping fonts.
export const VENDORED_FONTS = join(ROOT, "assets", "fonts", "newsreader");
