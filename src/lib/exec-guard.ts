// exec-guard.ts — Command screening for shell-executing routes.
//
// The old defense was BLOCKED_COMMANDS substring matching, which any attacker
// with an imagination defeats:
//   - `FOO=x sh payload.sh`          (env-assignment prefix)
//   - `echo cm0gLXJmIH4= | base64 -d | sh`   (encode → pipe)
//   - `$(printf 'rm -rf /')`         (substitution hides the substring)
//   - payload split across `\n`      (per-line matching missed it)
//   - `\r`-obfuscation, `2>/dev/null; rm -rf /`
//
// AND it blocked plenty of harmless work:
//   - `rm -rf ./dist` (matched "rm -rf .")
//   - `npm run format` (matched "format")
//   - `git commit -m "document shutdown handling"` (matched "shutdown")
//   - `echo "$(git rev-parse HEAD)"` (any `$(` was refused)
//
// So the screen is now ARGUMENT-AWARE: the command is tokenized (quote
// aware), each segment is judged by its command word and its targets, and
// dangerous forms are refused by what they DO — not by which letters they
// contain. Command substitution is allowed but its CONTENTS are screened
// recursively, so `$(git rev-parse HEAD)` works while `$(rm -rf /)` does not.
//
// This module is a heuristic layer for the DESKTOP/local product where the
// user runs their own machine — it is deliberately not a sandbox. Hosted
// multi-user deployments must set AGENT_EXEC_DISABLED=1 (exec route kill
// switch) and rely on run_in_sandbox.

// Environment variable names that must never reach a child process. Exact
// names are always stripped; suffixed variants are stripped too, EXCEPT
// public-ish and path-valued names (NEXT_PUBLIC_*, *_PATH, *_FILE, …) which
// are commonly needed by build tools and hold no secret.
const BLOCKED_ENV_KEYS_EXACT = [
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
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_SECRET",
];

const BLOCKED_ENV_KEY_SUFFIX = /_(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS|ACCESS_KEY|SESSION_KEY)$/;
const PUBLIC_ENV_KEY_PREFIX = /^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_)/;
const HARMLESS_ENV_KEY_SUFFIX = /_(PATH|FILE|DIR|URL|HOST|PORT|NAME|ORIGIN|SOURCE)$/;

/** True when the environment variable must not be inherited by a child. */
export function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLOCKED_ENV_KEYS_EXACT.includes(upper)) return true;
  if (PUBLIC_ENV_KEY_PREFIX.test(upper)) return false;
  if (HARMLESS_ENV_KEY_SUFFIX.test(upper)) return false;
  return BLOCKED_ENV_KEY_SUFFIX.test(upper);
}

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
    if (isBlockedEnvKey(key)) continue;
    safeEnv[key] = value;
  }
  delete safeEnv.NODE_ENV;
  return safeEnv;
}

// ---------------------------------------------------------------- parsing ---

const SHELL_WORDS = new Set(["sh", "bash", "zsh", "ksh", "dash", "shell", "fish"]);

/** Replace quoted regions with spaces so text rules cannot match inside them. */
function maskQuoted(command: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

interface Segment {
  raw: string;
  masked: string;
  /** Operator that ended this segment ("|", "&", ";" …). */
  op: string;
}

function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let cur = "";
  let quote: string | null = null;
  let op = "";
  const push = (nextOp: string) => {
    const raw = cur.trim();
    if (raw) segments.push({ raw, masked: maskQuoted(raw), op });
    cur = "";
    op = nextOp;
  };
  for (const ch of command) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      push(ch);
      continue;
    }
    cur += ch;
  }
  push(op);
  return segments;
}

function tokenize(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function unquote(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

function commandWord(token: string): string {
  const bare = unquote(token);
  const base = bare.split(/[\\/]/).pop() || bare;
  return base.toLowerCase();
}

function stripEnvPrefix(tokens: string[]): { envCount: number; rest: string[] } {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return { envCount: i, rest: tokens.slice(i) };
}

/** Targets that must never be destroyed, whatever the flags. */
function isDangerousTarget(target: string): boolean {
  const raw = unquote(target).trim();
  if (!raw) return false;
  const t = raw.replace(/[\\/]+$/, "") || raw; // "/" must stay "/"
  if (t === "/" || t === "\\" || t === "*" || t === "~" || t === "." || t === ".." || t === "./" || t === "../") return true;
  if (/\$HOME|%USERPROFILE%|\$USERPROFILE/i.test(t)) return true;
  if (/^[A-Za-z]:$/.test(t)) return true;
  const systemRoots = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/var",
    "/home",
    "/root",
    "/opt",
    "/boot",
    "/dev",
    "/sys",
    "/proc",
    "/system",
    "/library",
    "/applications",
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
  ];
  const lower = t.toLowerCase();
  return systemRoots.some((root) => lower === root || lower.startsWith(root + "/") || lower.startsWith(root + "\\"));
}

function hasRecursiveFlag(args: string[]): boolean {
  return args.some((a) => {
    if (/^-[a-zA-Z]+$/.test(a)) return /[rR]/.test(a); // -rf, -fr, -r, -R, -Recurse
    if (/^\/[a-zA-Z]+$/.test(a)) return /[sS]/.test(a); // /s, /S (Windows)
    return false;
  });
}

// ------------------------------------------------------- segment screening ---

function screenSegment(seg: Segment, maskedCommand: string): string | null {
  const tokens = tokenize(seg.raw);
  if (tokens.length === 0) return null;
  const { envCount, rest } = stripEnvPrefix(tokens);
  if (rest.length === 0) return null;

  let cmd = commandWord(rest[0]);
  let args = rest.slice(1).map(unquote);

  // Unwrap command wrappers so `sudo rm -rf /` is judged as `rm -rf /`.
  let cmdIndex = 0;
  while (["sudo", "doas", "nohup", "time", "command", "env"].includes(cmd) && args.length > 0) {
    const next = commandWord(args[0]);
    if (next === cmd || next === "") break;
    // Skip wrapper flags (sudo -u user, env KEY=VAL …).
    let i = 0;
    while (i < args.length && (args[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) i++;
    if (i >= args.length) break;
    cmd = next;
    args = args.slice(i + 1);
    cmdIndex++;
    if (cmdIndex > 3) break;
  }

  // env-prefixed SHELL invocation — `FOO=x sh payload.sh` is the classic
  // obfuscation. A literal env prefix before a normal binary (NODE_ENV=production
  // node server.js) is legitimate and allowed.
  if (envCount > 0 && SHELL_WORDS.has(cmd)) {
    return "environment-prefixed shell invocation (FOO=… sh/…) is not permitted";
  }

  // Piping into a shell: `curl … | sh`, `cat payload | bash`.
  if (seg.op === "|" && SHELL_WORDS.has(cmd)) {
    return "piping into a shell interpreter is not permitted";
  }

  // Recursive deletion — only refused when the TARGET is a root/system path.
  if (["rm", "rmdir", "rd", "del", "erase", "remove-item"].includes(cmd)) {
    const recursive = hasRecursiveFlag(args);
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && targets.some(isDangerousTarget)) {
      return `recursive delete of a root or system path is not permitted (${targets.join(", ")})`;
    }
    if (cmd === "rm" && targets.length === 0 && recursive) {
      return "recursive delete without an explicit target is not permitted";
    }
  }

  // Raw disk / filesystem destruction.
  if (cmd === "mkfs" || cmd.startsWith("mkfs.")) {
    return "filesystem formatting is not permitted";
  }
  if (cmd === "dd") {
    const of = args.find((a) => a.toLowerCase().startsWith("of="));
    if (of && (/of=\/dev\//.test(of) || /of=[A-Za-z]:/i.test(of) || /of=\\\\/.test(of))) {
      return "raw device writes are not permitted";
    }
  }
  if (cmd === "format" || cmd === "format.com") {
    return "disk formatting is not permitted";
  }

  // Power / session control — only as the command itself.
  if (["shutdown", "reboot", "halt", "poweroff"].includes(cmd)) {
    return "power control commands are not permitted";
  }
  if (cmd === "init" && args.some((a) => a === "0" || a === "6")) {
    return "power control commands are not permitted";
  }

  // Fork bomb.
  if (/:\(\)\s*\{.*\|.*&.*\}\s*;\s*:/.test(maskedCommand)) {
    return "fork bomb pattern is not permitted";
  }

  // Privilege escalation into another account.
  if (cmd === "su") {
    return "switching accounts with su is not permitted";
  }
  if (cmd === "sudo" && args.some((a) => a === "su" || a === "su -")) {
    return "switching accounts with sudo su is not permitted";
  }

  // Destructive SQL — matched on unquoted text only.
  if (/\bdrop\s+(database|table)\b/i.test(maskedCommand) || /\btruncate\s+table\b/i.test(maskedCommand)) {
    return "destructive SQL statements are not permitted";
  }

  // Environment destruction (breaks every later command in the session).
  if ((cmd === "export" || cmd === "unset") && args.some((a) => a.toUpperCase() === "PATH")) {
    return "modifying PATH is not permitted";
  }

  // Mass process kills.
  if (cmd === "killall" || cmd === "pkill") {
    return "mass process termination is not permitted";
  }
  if (/\bkill\s+-9\s+1\b/.test(maskedCommand)) {
    return "killing pid 1 is not permitted";
  }

  // World-writable system paths.
  if (cmd === "chmod") {
    const recursive = hasRecursiveFlag(args);
    const targets = args.filter((a) => !a.startsWith("-") && !/^\d{3,4}$/.test(a));
    if (recursive && args.some((a) => a === "777") && targets.some(isDangerousTarget)) {
      return "world-writable permissions on a root or system path are not permitted";
    }
  }
  if (cmd === "chown") {
    const recursive = hasRecursiveFlag(args);
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && targets.some(isDangerousTarget)) {
      return "recursive ownership change on a root or system path is not permitted";
    }
  }

  // Process substitution — rare in agent work, but a redirection trick.
  if (/<\(/.test(seg.masked) || />\(/.test(seg.masked)) {
    return "process substitution is not permitted";
  }

  return null;
}

/** Extract `$( … )` / backtick contents so they can be screened recursively. */
function extractSubstitutions(command: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
        if (depth === 0) break;
        j++;
      }
      found.push(command.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    if (command[i] === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return found;
}

/** True when the command should never reach a shell on this host. */
export function isCommandAllowed(
  command: string
): { allowed: true } | { allowed: false; reason: string } {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allowed: false, reason: "empty command" };
  }
  if (command.length > 4000) {
    return { allowed: false, reason: "command too long (4000 char cap)" };
  }

  // Newline/carriage-return payloads: block outright. Legitimate interactive
  // commands are single-line; multi-line scripts belong in a file.
  if (/[\r\n]/.test(command)) {
    return { allowed: false, reason: "multi-line commands are not permitted — write a script file and run it as one command" };
  }

  // Control characters (NUL, ESC, …) are pure obfuscation.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) {
    return { allowed: false, reason: "control characters are not permitted in commands" };
  }

  // Command substitution is allowed, but its CONTENTS are screened too — a
  // hidden payload inside $() is exactly what the old ban was protecting
  // against, so the ban moves from "any $()" to "a dangerous $()".
  for (const inner of extractSubstitutions(command)) {
    const innerVerdict = isCommandAllowed(inner.trim());
    if (!innerVerdict.allowed) {
      return { allowed: false, reason: `command substitution content is not permitted: ${innerVerdict.reason}` };
    }
  }

  const maskedCommand = maskQuoted(command);
  const segments = splitSegments(command);
  for (const seg of segments) {
    const refusal = screenSegment(seg, maskedCommand);
    if (refusal) return { allowed: false, reason: refusal };
  }

  // Encode-and-pipe-to-shell (the pipe-into-shell rule above catches the
  // common shape; this catches the decoder variants).
  if (/(?:base64|openssl\s+(?:enc|dgst)|xxd|certutil|(?:python3?|perl|ruby|node)\s+-[eerc])\b[^|;&]*\|\s*(?:ba|z|da|k)?sh\b/i.test(maskedCommand)) {
    return { allowed: false, reason: "decode-and-pipe-to-shell pattern is not permitted" };
  }

  return { allowed: true };
}
