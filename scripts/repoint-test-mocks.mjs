// repoint-test-mocks.mjs — after a module moves into @orplex/sdk, a test that
// does jest.mock("@/lib/x") mocks the *shim*, not the module the runtime
// actually calls, so the mock is silently bypassed and the test fails for the
// wrong reason. Point those mocks at the real module path.
import fs from "node:fs";
import path from "node:path";

const APP = "D:/orplex";
const LIB = path.join(APP, "src/lib");

const isShim = (file) => {
  try {
    return fs.readFileSync(file, "utf8").includes("@orplex/sdk/lib/");
  } catch {
    return false;
  }
};

const toSdkSpecifier = (spec) => {
  if (!spec.startsWith("@/lib/")) return null;
  const rel = spec.slice("@/lib/".length);
  const direct = path.join(LIB, `${rel}.ts`);
  if (fs.existsSync(direct) && isShim(direct)) return `@orplex/sdk/lib/${rel}`;
  const indexFile = path.join(LIB, rel, "index.ts");
  if (fs.existsSync(indexFile) && isShim(indexFile)) return `@orplex/sdk/lib/${rel}/index`;
  return null;
};

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

let changedFiles = 0;
const rewrites = [];

for (const file of walk(path.join(APP, "src"))) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  // jest.mock / jest.requireActual / jest.requireMock / jest.unstable_mockModule
  for (const call of ["jest.mock", "jest.requireActual", "jest.requireMock", "jest.unstable_mockModule", "jest.doMock"]) {
    const re = new RegExp(`${call}\\(\\s*"(@/lib/[^"]+)"`, "g");
    after = after.replace(re, (match, spec) => {
      const sdk = toSdkSpecifier(spec);
      if (!sdk) return match;
      rewrites.push(`${path.relative(APP, file)}: ${spec} → ${sdk}`);
      return match.replace(spec, sdk);
    });
  }
  if (after !== before) {
    fs.writeFileSync(file, after, "utf8");
    changedFiles++;
  }
}

console.log(`repointed ${rewrites.length} mock(s) in ${changedFiles} test file(s)`);
for (const r of rewrites) console.log("  " + r);
