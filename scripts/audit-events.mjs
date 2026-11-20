import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const dirs = ["src", "electron"];

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
const dispatched = new Set();
const listened = new Set();

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/new CustomEvent\(\s*['"]([^'"]+)['"]/g)) dispatched.add(m[1]);
  for (const m of src.matchAll(/addEventListener\(\s*['"]([^'"]+)['"]/g)) listened.add(m[1]);
  for (const m of src.matchAll(/useEvent\(\s*['"]([^'"]+)['"]/g)) listened.add(m[1]);
}

const dOnly = [...dispatched].filter((e) => !listened.has(e));
const lOnly = [...listened].filter((e) => !dispatched.has(e) && e.startsWith("orplex"));

console.log("Dispatched events:", dispatched.size);
console.log("Listened events:", listened.size);
if (dOnly.length) console.log("\nDispatched but never listened:\n  " + dOnly.join("\n  "));
if (lOnly.length) console.log("\nListened (orplex:*) but never dispatched:\n  " + lOnly.join("\n  "));
if (!dOnly.length && !lOnly.length) console.log("\nEvent audit: clean");
process.exit(0);
