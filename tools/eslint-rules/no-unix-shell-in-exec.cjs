// no-unix-shell-in-exec — custom ESLint rule (flat config, ESLint 9)
//
// Guards the bug class documented in docs-site/docs/guides/agent-portability.md:
// on Windows, the app's child_process calls run through cmd.exe, where Unix-only
// shell syntax (`mkdir -p`, `rm -rf`, pipes, `$?`, redirections, globs) silently
// fails or explodes. This bit the repo twice — `mkdir -p` in parallel-workspaces
// and `pg_dump | gzip` in backup.ts — so the rule makes the pattern un-writable.
//
// WHAT it checks:
//   * Call expressions whose callee is exec/execSync/execFile/execFileSync/
//     spawn/spawnSync (incl. `cp.execSync(...)`, dynamic `proc.exec(...)`, and
//     dynamic imports), and
//   * Awaiting `import("child_process")` results.
//
// WHAT it flags:
//   1. A STRING-literal argument containing Unix-only shell tokens
//      (mkdir -p, rm -rf, pipes, &&/||, ;, redirects, globs, $VAR, ~).
//      Note spawn-family calls with shell:false (the default) never even
//      reach a shell — but a pipe in a spawn string is ALWAYS a mistake,
//      so it is still flagged.
//   2. `shell: true` options (requires an inline eslint-disable with a reason).
//
// WHAT it deliberately ignores:
//   * Regex `.exec(...)` / `.execSync` on non-child_process receivers, and any
//     receiver not resolving to the child_process module.
//   * Dynamic STRING commands from the agent (`exec(command, ...)` on a bare
//     identifier whose import cannot be statically resolved) — those are the
//     guarded-shell feature, not a hardcoded Unix assumption. This is exactly
//     why the rule tracks child_process imports instead of pattern-matching
//     every `exec(` in the codebase.
//
// Options (second arg, all optional):
//   { allowFiles: string[] } — glob-style suffixes (matched with endsWith,
//     converted to posix separators) where the rule is off entirely,
//     e.g. ["electron/main.ts"] for platform-branched kill logic.

"use strict";

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);

const EXEC_CALLEES = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);

const TOKENS = [
  ["pipe", /\|/],
  ["and-chain", /&&/],
  ["or-chain", /\|\|/],
  ["command-separator", /;\s*\S/],
  ["output-redirect", /(^|[^>])>{1,2}\s*\S/],
  ["input-redirect", /<\s*\S/],
  ["mkdir -p", /\bmkdir\s+(-[a-zA-Z]*p|--parents)\b/],
  ["rm -rf", /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/],
  ["cp -r", /\bcp\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)+/],
  ["shell substitution", /\$\{?[\w(?]/],
  ["command substitution", /`[^`]*`/],
  ["glob", /(^|[\s"'])\*(?=$|[\s"'])/],
  ["home shorthand", /(^|[\s"'])~\//],
];

/** True if the string contains a Unix-only shell token. Returns the token kind. */
function findToken(s) {
  for (const [kind, re] of TOKENS) {
    if (re.test(s)) return kind;
  }
  return null;
}

/** Resolve an identifier to a module specifier when `import x from "mod"` or `const x = require("mod")`. */
function specifierForIdentifier(scope, name) {
  let v = scope;
  while (v) {
    const ref = v.set && v.set.get(name);
    if (ref && ref.defs.length > 0) {
      const def = ref.defs[0];
      if (def.type === "ImportBinding" && def.parent && def.parent.source) {
        return def.parent.source.value;
      }
      if (
        def.type === "Variable" &&
        def.parent &&
        def.parent.type === "VariableDeclarator" &&
        def.parent.init &&
        def.parent.init.type === "CallExpression" &&
        def.parent.init.callee.type === "Identifier" &&
        def.parent.init.callee.name === "require" &&
        def.parent.init.arguments.length > 0 &&
        def.parent.init.arguments[0].type === "Literal"
      ) {
        return def.parent.init.arguments[0].value;
      }
      return undefined;
    }
    v = v.upper;
  }
  return undefined;
}

/** Is `node` (CallExpression) a require/import of child_process? */
function isChildProcessRequire(node) {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  const args = node.arguments;
  if (callee.type === "Identifier" && callee.name === "require" && args.length > 0 && args[0].type === "Literal") {
    return CHILD_PROCESS_MODULES.has(args[0].value);
  }
  if (
    callee.type === "Import" &&
    args.length > 0 &&
    args[0].type === "Literal" &&
    CHILD_PROCESS_MODULES.has(args[0].value)
  ) {
    return true;
  }
  return false;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Unix-only shell tokens in child_process exec/spawn calls",
      url: "docs-site/docs/guides/agent-portability.md",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowFiles: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unixToken:
        "child_process call contains a Unix-only shell token ({{kind}}) — cmd.exe at runtime has no such syntax. Use argv-array spawn/execFile and fs/promises (see docs-site/docs/guides/agent-portability.md).",
      shellTrue:
        "child_process call uses shell: true — on Windows the string is parsed by cmd.exe. Split into argv arrays or branch per platform with an inline eslint-disable and a reason.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowFiles = (options.allowFiles || []).map((p) => String(p).replace(/\\/g, "/"));
    const filename = String(context.filename || context.getFilename()).replace(/\\/g, "/");
    if (allowFiles.some((p) => filename.endsWith(p))) return {};

    // Identifiers bound to the child_process module (direct and namespaced).
    const cpIdentifiers = new Set();
    // Locals whose initializer is a require/import of child_process
    // (e.g. `const { exec } = require("child_process")` destructure support).
    const destructuredNames = new Set();

    function registerBinding(idNode) {
      if (idNode && idNode.type === "Identifier") cpIdentifiers.add(idNode.name);
    }

    return {
      ImportDeclaration(node) {
        if (CHILD_PROCESS_MODULES.has(node.source.value)) {
          for (const spec of node.specifiers) {
            if (spec.type === "ImportSpecifier") {
              destructuredNames.add(spec.local.name);
            } else {
              // ImportDefaultSpecifier (import cp from …) and
              // ImportNamespaceSpecifier (import * as cp from …).
              registerBinding(spec.local);
            }
          }
        }
      },
      CallExpression(node) {
        // Unwrap `await` / `yield` so `const cp = await import("child_process")`
        // registers the same as a plain require.
        let container = node.parent;
        if (container && (container.type === "AwaitExpression" || container.type === "YieldExpression")) {
          container = container.parent;
        }
        // const cp = require("child_process") / await import("child_process") —
        // plain identifier OR destructured ({ exec, spawn } = require(…)).
        if (isChildProcessRequire(node)) {
          if (container && container.type === "VariableDeclarator") {
            if (container.id.type === "Identifier") {
              registerBinding(container.id);
            } else if (container.id.type === "ObjectPattern") {
              for (const p of container.id.properties) {
                if (p.type === "Property" && p.value.type === "Identifier") destructuredNames.add(p.value.name);
              }
            }
          }
          return;
        }
      },
      "CallExpression:exit"(node) {
        const callee = node.callee;

        let name = null;
        let isCpCall = false;

        if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
          name = callee.property.name;
          const obj = callee.object;
          isCpCall = obj.type === "Identifier" && cpIdentifiers.has(obj.name);
        } else if (callee.type === "Identifier") {
          name = callee.name;
          isCpCall = cpIdentifiers.has(name) || destructuredNames.has(name);
        }

        if (!isCpCall || !EXEC_CALLEES.has(name)) return;

        // Flag shell: true in the options object (last object arg).
        const opts = node.arguments.find(
          (a) => a.type === "ObjectExpression" && !a.properties.some((p) => p.type === "SpreadElement"),
        );
        if (opts) {
          for (const p of opts.properties) {
            if (
              p.type === "Property" &&
              !p.computed &&
              ((p.key.type === "Identifier" && p.key.name === "shell") ||
                (p.key.type === "Literal" && p.key.value === "shell")) &&
              p.value.type === "Literal" &&
              p.value.value === true
            ) {
              context.report({ node: p.value, messageId: "shellTrue" });
            }
          }
        }

        // Flag Unix-only tokens in string-literal and template arguments.
        // For templates only the STATIC quasis are scanned — `execSync(`a | b ${x}`)`
        // is flagged via the "a | b " quasi, while `git branch "${b}"` stays clean.
        for (const arg of node.arguments) {
          if (arg.type === "Literal" && typeof arg.value === "string") {
            const kind = findToken(arg.value);
            if (kind) {
              context.report({ node: arg, messageId: "unixToken", data: { kind } });
            }
          } else if (arg.type === "TemplateLiteral") {
            for (const quasi of arg.quasis) {
              const kind = quasi.value.cooked ? findToken(quasi.value.cooked) : null;
              if (kind) {
                context.report({ node: quasi, messageId: "unixToken", data: { kind } });
              }
            }
          }
        }
      },
    };
  },
};
