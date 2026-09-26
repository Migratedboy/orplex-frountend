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
