// One-shot codemod: rewrite client `fetch("/api/…")` → `apiFetch("/api/…")`
// and add the import. Browser code only (components/hooks/lib); server-only
// dirs and tests are skipped. Dry-run by default — `node scripts/codemod-apibase.mjs --write` applies.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIRS = ["src/components", "src/hooks", "src/lib"];
const SKIP = new Set(["src/lib/api-base.ts"]);
const SKIP_RE = /[\\/](__tests__|server-executor)[\\/]/;
const IMPORT_LINE = 'import { apiFetch } from "@/lib/api-base";';

const PATTERNS = [
  [/fetch\("\/api/g, 'apiFetch("/api'],
  [/fetch\('\/api/g, "apiFetch('/api"],
  [/fetch\(`\/api/g, "apiFetch(`/api"],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d))).filter(
  (p) => !SKIP.has(path.relative(ROOT, p).replace(/\\/g, "/")) && !SKIP_RE.test(p)
);

let touched = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  let out = src;
  let count = 0;
  for (const [re, to] of PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return to;
    });
  }
  if (count === 0) continue;
  if (out.includes('from "@/lib/api-base"')) {
    // import already present
  } else {
    const imports = [...out.matchAll(/^import[^\n]*(?:\n(?![ \t\n]))?/gm)];
    const last = imports[imports.length - 1];
    if (last) {
      const at = last.index + last[0].length;
      out = out.slice(0, at) + "\n" + IMPORT_LINE + out.slice(at);
    } else {
      out = IMPORT_LINE + "\n\n" + out;
    }
  }
  const rel = path.relative(ROOT, file);
  if (process.argv.includes("--write")) {
    fs.writeFileSync(file, out, "utf8");
    console.log(`rewrote ${rel} (${count} call${count === 1 ? "" : "s"})`);
  } else {
    console.log(`[dry] ${rel} (${count} call${count === 1 ? "" : "s"})`);
  }
  touched++;
}
console.log(touched === 0 ? "nothing to do" : `${touched} file(s) ${process.argv.includes("--write") ? "rewritten" : "would be rewritten"} — run with --write to apply`);
