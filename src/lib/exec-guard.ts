// exec-guard.ts — Server-side command screening for shell-executing routes.
//
// The old defense was BLOCKED_COMMANDS substring matching, which any attacker
// with an imagination defeats:
//   - `FOO=x sh payload.sh`          (env-assignment prefix)
//   - `echo cm0gLXJmIH4= | base64 -d | sh`   (encode → pipe)
//   - `$(printf 'rm -rf /')`         (substitution hides the substring)
//   - payload split across `\n`      (per-line matching missed it)
//   - `\r`-obfuscation, `2>/dev/null; rm -rf /`
//
// This module screens the command text in a way that doesn't depend on seeing
// the payload verbatim. It is a heuristic layer for the DESKTOP/local product
// where the user execs their own machine — it is deliberately not a sandbox.
// Hosted multi-user deployments must set AGENT_EXEC_DISABLED=1 (exec route
// kill switch) and rely on run_in_sandbox.

import { BLOCKED_COMMANDS } from "./constants";

// Environment variable names (substring, upper-cased) that must never reach
// a child process — shared by every shell-executing route (exec, terminal,
// terminal/stream). Single source of truth so the lists can't drift.
const BLOCKED_ENV_KEYS = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "DOCKER_PASSWORD",
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "JWT_SECRET",
  "PRIVATE_KEY",
  "SECRET_KEY",
  "API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BUGSINK_DSN",
  "E2B_API_KEY",
];

/**
 * Inherit the environment for spawned build tools (npm/node/git resolve),
 * minus secret-valued keys. Callers must NOT spread process.env directly.
 * Cast to NodeJS.ProcessEnv at the spawn/exec call site (same as the exec
 * route does) — @types/node's ProcessEnv cannot be constructed literally.
 */
export function buildSafeEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (BLOCKED_ENV_KEYS.some((blocked) => upperKey.includes(blocked))) continue;
    safeEnv[key] = value;
  }
  delete safeEnv.NODE_ENV;
  return safeEnv;
}

/** True when the command should never reach a shell on this host. */
export function isCommandAllowed(
  command: string
): { allowed: true } | { allowed: false; reason: string } {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allowed: false, reason: "empty command" };
  }

  // Newline/carriage-return payloads: block outright. Legitimate interactive
  // commands are single-line; multi-line scripts belong in a file (and the
  // old matcher treated each line independently, missing combined payloads).
  if (/[\r\n]/.test(command)) {
    return { allowed: false, reason: "multi-line commands are not permitted — write a script file and run it as one command" };
  }

  const lower = command.toLowerCase();

  // Legacy substring blocklist still applies — on the raw text AND on a
  // de-obfuscated variant with control separators collapsed, so `rm -rf /\r`
  // or `rm\u0000-rf` cannot sneak past.
  const collapsed = lower.replace(/[\u0000-\u001f\u007f]+/g, "");
  for (const blocked of BLOCKED_COMMANDS) {
    const b = blocked.toLowerCase();
    if (lower.includes(b) || collapsed.includes(b)) {
      return { allowed: false, reason: `matches blocked pattern: ${b}` };
    }
  }

  // Structural-evasion heuristics:
  //   1. env-assignment prefix:  `FOO=bar sh …`, `NODE_ENV=x npm …`
  //      (lets arbitrary interpreters run while the first token looks tame)
  const envPrefix = /(?:^|[\s;|&])([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*))\s+(?=(?:[A-Za-z_][A-Za-z0-9_]*=\s*)*(?:sh|bash|zsh|ksh|dash|cmd|powershell|pwsh|python3?|perl|ruby|node|eval|exec|source)\b)/i;
  if (envPrefix.test(command)) {
    return { allowed: false, reason: "environment-prefixed interpreter invocation (FOO=… sh/…) is not permitted" };
  }

  //   2. encode-to-shell pipes: any `<decoder> … | sh|bash|zsh` pattern, and
  //      also `| sh` variants written as `> >(sh)` / `; sh` with encoded input.
  const decodePipe = /(?:base64|openssl\s+(?:enc|dgst)|xxd|certutil|(?:python3?|perl|ruby|node)\s+-[eerc]\b)[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i;
  if (decodePipe.test(command)) {
    return { allowed: false, reason: "decode-and-pipe-to-shell pattern is not permitted" };
  }

  //   3. generic remote-content-to-shell: curl/wget/iwr output piped or
  //      executed. (`curl | sh` was already blocked; these are the variants.)
  const remoteToShell = /(?:curl|wget|fetch|iwr|invoke-webrequest|invoke-restmethod)[^|;&)]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|(?:curl|wget|fetch)[^|;&)]*\|\s*(?:sudo\s+)?(?:bash|powershell|pwsh|python3?|perl|ruby|node)\b/i;
  if (remoteToShell.test(command)) {
    return { allowed: false, reason: "piping remote content into an interpreter is not permitted" };
  }

  //   4. command substitution that hides a payload: `$( … )` / backticks.
  //      These make substring matching unreliable, so refuse them entirely —
  //      every legitimate build/test command we run is substitution-free.
  if (/\$\(/.test(command) || /`/.test(command)) {
    return { allowed: false, reason: "command substitution ($() / backticks) is not permitted" };
  }

  //   5. process substitution / background-then-kill tricks: `<( … )`, `>( … )`.
  if (/<\(/.test(command) || />\(/.test(command)) {
    return { allowed: false, reason: "process substitution is not permitted" };
  }

  return { allowed: true };
}
