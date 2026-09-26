/**
 * RuleTester suite for tools/eslint-rules/no-unix-shell-in-exec.cjs — the
 * lint-side enforcement of docs-site/docs/guides/agent-portability.md.
 *
 * The rule must resolve which identifiers actually refer to child_process
 * (static import, namespace import, dynamic await-import, require,
 * require-destructure) and ignore regex `.exec()` and dynamic agent commands.
 */
import { RuleTester } from "eslint";
import rule from "../../../tools/eslint-rules/no-unix-shell-in-exec.cjs";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-unix-shell-in-exec", rule as never, {
  valid: [
    // Regex .exec is not child_process — must stay ignored.
    { code: `while ((m = re.exec(x)) !== null) {}` },
    { code: `const m = /a/.exec(str);` },
    // Unknown receiver/dynamic command: the guarded-shell feature.
    { code: `exec(command, { cwd, timeout }, cb);` },
    { code: `spawn(command, opts);` },
    { code: `const { execFile } = await import("child_process"); execFile(cmd, args, cb);` },
    { code: `const mod = await import("other-module"); mod.exec("x | y");` },
    // Argv-array spawns are the recommended shape.
    { code: `import { spawn } from "child_process"; spawn("pg_dump", ["--file", p, "--compress=gzip:6", dbUrl], { windowsHide: true });` },
    { code: `import { execFile } from "child_process"; execFile("git", ["worktree", "add", dir, branch]);` },
    { code: `import cp from "child_process"; cp.spawnSync("pg_dump", ["--version"], { stdio: "ignore" });` },
    // Template with interpolation only in the dynamic part.
    { code: `import { execSync } from "child_process"; execSync(\`git branch "\${branch}"\`, { stdio: "pipe" });` },
    { code: `import { execSync } from "child_process"; execSync("git status --porcelain", { cwd });` },
    // A leading star is not a glob separator pattern (covered by separator regex).
    { code: `import { execFile } from "child_process"; execFile("find", ["-name", "*.ts"], cb);` },
    // Allowlist file skips entirely.
    {
      code: `import { execSync } from "child_process"; execSync("a | b");`,
      options: [{ allowFiles: ["electron/main.ts"] }],
      filename: "D:/orplex/electron/main.ts",
    },
  ],
  invalid: [
    // The original backup.ts bug: shell pipe in a string.
    {
      code: `import { execSync } from "child_process"; execSync("pg_dump db | gzip > out.dump");`,
      // findToken reports the FIRST matching token — one error per string.
      errors: [{ messageId: "unixToken", data: { kind: "pipe" } }],
    },
    // The original parallel-workspaces bug: mkdir -p.
    {
      code: `import { execSync } from "child_process"; execSync("mkdir -p /tmp/x");`,
      errors: [{ messageId: "unixToken", data: { kind: "mkdir -p" } }],
    },
    {
      code: `import { execSync } from "child_process"; execSync("rm -rf build/");`,
      errors: [{ messageId: "unixToken", data: { kind: "rm -rf" } }],
    },
    {
      code: `import { execSync } from "child_process"; execSync("a && b");`,
      errors: [{ messageId: "unixToken", data: { kind: "and-chain" } }],
    },
    {
      code: `import { execSync } from "child_process"; execSync("a; echo done");`,
      errors: [{ messageId: "unixToken", data: { kind: "command-separator" } }],
    },
    {
      code: `import { execSync } from "child_process"; execSync("cmd $HOME/x");`,
      errors: [{ messageId: "unixToken", data: { kind: "shell substitution" } }],
    },
    {
      code: `import { execSync } from "child_process"; execSync("ls *");`,
      errors: [{ messageId: "unixToken", data: { kind: "glob" } }],
    },
    // Namespace + dynamic-import receivers.
    {
      code: `import cp from "child_process"; cp.execSync("mkdir -p x");`,
      errors: [{ messageId: "unixToken" }],
    },
    {
      code: `const { exec } = require("child_process"); exec("a | b");`,
      errors: [{ messageId: "unixToken" }],
    },
    // Template static quasi carrying a pipe.
    {
      code: `import { execSync } from "child_process"; execSync(\`a | b \${x}\`);`,
      errors: [{ messageId: "unixToken", data: { kind: "pipe" } }],
    },
    // shell: true requires an inline disable + reason.
    {
      code: `import { spawn } from "child_process"; spawn("npm", ["run", "build"], { shell: true });`,
      errors: [{ messageId: "shellTrue" }],
    },
    // allowFiles is an allowLIST, not a blanket pass: partial-suffix files stay checked.
    {
      code: `import { execSync } from "child_process"; execSync("mkdir -p x");`,
      options: [{ allowFiles: ["electron/main.ts"] }],
      filename: "D:/orplex/src/lib/other.ts",
      errors: [{ messageId: "unixToken" }],
    },
  ],
});
