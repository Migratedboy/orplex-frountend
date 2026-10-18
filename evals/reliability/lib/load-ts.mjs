/**
 * Real-module loader.
 *
 * The eval harness must exercise the PRODUCT's enforcement code, not a
 * reimplementation of it. Node 20 cannot import TypeScript directly and the
 * repo has no ts-node/tsx/esbuild, but `typescript` is a devDependency — so we
 * register a require hook that transpiles any `.ts` file on demand and let
 * Node's own resolver do the rest.
 *
 * The hook (rather than transpiling one file to a flat temp dir) is what makes
 * the harness survive the product growing real imports: risk-classifier.ts now
 * pulls in ./reliability/protected-paths and ./reliability/flags, and a flat
 * temp-dir rewrite would fail to resolve them — a harness failure that would be
 * misread as "capability missing". With `.ts` in require.extensions, an
 * extensionless relative require resolves to the real .ts file and is
 * transpiled on the spot, recursively.
 *
 * Bare specifiers (node builtins, npm packages) resolve normally, so a module
 * that imports `fs` or `zod` behaves exactly as it does in production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Map `@/...` (the repo's tsconfig path alias) onto the repo root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const require_ = createRequire(import.meta.url);

let ts;
try {
  ts = require_("typescript");
} catch {
  console.error("[eval] FATAL: typescript not resolvable. Run npm install first.");
  process.exit(2);
}

let hookInstalled = false;

function installHook() {
  if (hookInstalled) return;
  require_.extensions[".ts"] = function compileTs(mod, filename) {
    const source = readFileSync(filename, "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        // Allow importing .ts with an explicit extension too.
        allowJs: true,
      },
      fileName: filename,
    });
    // Rewrite the `@/` alias to a real path so aliased imports resolve here the
    // same way they do under the bundler/jest moduleNameMapper.
    const rewritten = out.outputText.replace(
      /require\(["'`]@\/([^"'`]+)["'`]\)/g,
      (_m, rest) => `require(${JSON.stringify(join(REPO_ROOT, "src", rest))})`,
    );
    mod._compile(rewritten, filename);
  };
  hookInstalled = true;
}

/**
 * Transpile `absPath` and return its exports. Relative TS imports are resolved
 * and transpiled recursively by the hook. Throws a clear error rather than
 * silently returning {} so a harness failure is never mistaken for
 * "capability missing".
 */
export function loadTs(absPath) {
  installHook();
  try {
    return require_(absPath);
  } catch (err) {
    throw new Error(
      `loadTs failed for ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function cleanup() {
  // The require cache holds compiled modules; drop ours so a second run in the
  // same process re-reads edited sources. Node builtins/other requires are left
  // alone — they are not ours to manage.
  for (const key of Object.keys(require_.cache)) {
    if (key.endsWith(".ts")) delete require_.cache[key];
  }
}