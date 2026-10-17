/**
 * Real-module loader.
 *
 * The eval harness must exercise the PRODUCT's enforcement code, not a
 * reimplementation of it. Node 20 cannot import TypeScript directly and the
 * repo has no ts-node/tsx/esbuild, but `typescript` is a devDependency — so we
 * transpile the single modules we need to CommonJS in a temp dir and require
 * them.
 *
 * Only dependency-free modules are loadable this way. plan-gate.ts,
 * risk-classifier.ts and loop-detect.ts all import nothing, which is what makes
 * this possible; a module that starts importing must be driven differently.
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const require_ = createRequire(import.meta.url);

let ts;
try {
  ts = require_("typescript");
} catch {
  console.error("[eval] FATAL: typescript not resolvable. Run npm install first.");
  process.exit(2);
}

const CACHE_DIR = join(tmpdir(), "orplex-eval-ts");
let counter = 0;

/**
 * Transpile `absPath` and return its exports.
 * Throws a clear error rather than silently returning {} so a harness failure
 * is never mistaken for "capability missing".
 */
export function loadTs(absPath) {
  const source = readFileSync(absPath, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: absPath,
  });
  mkdirSync(CACHE_DIR, { recursive: true });
  const stem = absPath.replace(/[^a-zA-Z0-9]/g, "_");
  const jsPath = join(CACHE_DIR, `${stem}.${counter++}.cjs`);
  writeFileSync(jsPath, out.outputText, "utf8");
  try {
    return require_(jsPath);
  } finally {
    // The module object is fully materialised; the file is no longer needed.
    rmSync(jsPath, { force: true });
  }
}

export function cleanup() {
  rmSync(CACHE_DIR, { recursive: true, force: true });
}