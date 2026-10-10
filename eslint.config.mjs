import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import noUnixShellInExec from "./tools/eslint-rules/no-unix-shell-in-exec.cjs";

export default defineConfig([
  ...nextVitals,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Portability guard: cmd.exe at runtime has no mkdir -p / pipes / $?
    // (see docs-site/docs/guides/agent-portability.md). electron/main.ts is
    // allowlisted — its kill/port logic is deliberately platform-branched.
    plugins: {
      "no-unix-shell-in-exec": {
        rules: {
          "no-unix-shell-in-exec": noUnixShellInExec,
        },
      },
    },
    rules: {
      "no-unix-shell-in-exec/no-unix-shell-in-exec": "error",
    },
  },
  // .cloud-fix/ is a stale, divergent snapshot of the app (not built, not
  // imported, not shipped) — linting it just hides the real findings.
  globalIgnores([".next/**", "node_modules/**", "docs-site/.docusaurus/**", "docs-site/build/**", "logo/**", "electron-dist/**", "release/**", "tmp/**", ".cloud-fix/**"]),
]);