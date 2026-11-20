import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const dirs = ["src", "electron"];
const allowlistPath = join(root, "scripts", "placeholder-allowlist.json");

let allowlist = {};
try {
  allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
} catch {
  allowlist = {};
}

const patterns = [
  /goes here/i,
  /coming soon/i,
  /not implemented/i,
  /isn['’]t connected/i,
  /in this preview/i,
  /outer shell/i,
  /lorem/i,
  /dummy/i,
  /example-server/i,
  /mcp\.example\.com/i,
  /you@example\.com/i,
  /window\.orplex(Account|Usage|Skills|Integrations|Host|Version)/,
  /window\.setOrplex/,
  /SAMPLE_ACCOUNT/,
  /INT_SAMPLE/,
  /DEFAULT_SKILLS/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /catch\s*\(\s*[^)]*\s*\)\s*\{\s*\}/,
];

const isTest = (p) => /\.test\./.test(p) || /__tests__|__fixtures__/.test(p);
const isExcluded = (p) => /node_modules|\.next|design\/|docs\//.test(p);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => walk(join(root, d)));
let hits = 0;
for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, "/");
  if (isExcluded(rel) || isTest(rel)) continue;
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of patterns) {
      if (re.test(line)) {
        const key = `${rel}:${i + 1}`;
        if (allowlist[key]) continue;
        console.log(`[placeholder] ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        hits++;
      }
    }
  });
}

console.log(`\nplaceholder scan: ${hits} hit(s)${hits ? "" : " (clean)"}`);
if (hits > 0) process.exit(1);
process.exit(0);
