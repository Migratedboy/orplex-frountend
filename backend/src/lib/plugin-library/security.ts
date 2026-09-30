// plugin-library/security.ts — Security category: 8 bundles.

import { SKILL_HEADER, type BundleDef } from "./types";

export const SECURITY_BUNDLES: BundleDef[] = [
  {
    slug: "secret-hygiene",
    category: "security",
    version: "1.0.0",
    description: "Blocks tool calls that would write or echo credential-shaped strings (AWS keys, GitHub tokens, private key blocks) before they land in any file or log.",
    skills: [
      {
        name: "secret-hygiene",
        body:
          SKILL_HEADER("Secret hygiene", "Credentials never belong in source, logs, or command output.") +
          `## Rules

1. Read secrets from environment variables or a secrets manager — never hardcode them, even "temporarily".
2. If you see a credential-shaped string in a diff or a file you are editing, stop and flag it to the user instead of preserving it.
3. Example/env files use placeholders (your-key-here), never real-looking values.
4. When a command might echo secrets (env, printenv, config dumps), prefer the narrow command that shows only what you need.
`,
      },
    ],
    hooks: {
      deny: [
        "AKIA[0-9A-Z]{16}",
        "ghp_[A-Za-z0-9]{30,}",
        "github_pat_[A-Za-z0-9_]{20,}",
        "sk-[A-Za-z0-9]{20,}",
        "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
      ],
      notify: ["run_command.*env", "run_command.*printenv"],
    },
  },
  {
    slug: "input-validation",
    category: "security",
    version: "1.0.0",
    description: "Every request body, query param, and external input is schema-validated before use — zod at the boundary.",
    skills: [
      {
        name: "input-validation",
        body:
          SKILL_HEADER("Input validation", "The boundary is where trust ends — validate everything crossing it.") +
          `## Rules

1. Parse request bodies with a schema (zod) and reject with 400 + flattened issues on failure.
2. Validate query params and route params too — ids, pagination, enums — not just bodies.
3. Never interpolate raw input into shell commands, SQL, or HTML. Use parameterized APIs exclusively.
4. Length-cap and type-check strings before storing or echoing them.
5. External API responses get the same treatment: parse into a typed shape, assume nothing.
`,
      },
    ],
  },
  {
    slug: "auth-gates",
    category: "security",
    version: "1.0.0",
    description: "Route handlers authenticate first: session checked before any work, per-user scoping on every query.",
    skills: [
      {
        name: "auth-gates",
        body:
          SKILL_HEADER("Auth gates", "Authentication is a precondition, not a feature.") +
          `## Rules

1. Every new route handler starts with the session check and returns 401 before touching data.
2. Scope every DB query by the authenticated user's id — never trust a userId from the request body.
3. Admin-only surfaces check the role/flag explicitly; absence of a UI is not access control.
4. Webhooks verify signatures before parsing payloads.
5. Idempotent side effects still require auth — replaying an authenticated action is not an auth bypass.
`,
      },
    ],
  },
  {
    slug: "path-containment",
    category: "security",
    version: "1.0.0",
    description: "File operations stay inside the workspace: absolute-path escapes, traversal, and symlink hops are refused.",
    skills: [
      {
        name: "path-containment",
        body:
          SKILL_HEADER("Path containment", "A path from outside the workspace is untrusted input.") +
          `## Rules

1. Resolve every user-supplied path and verify it is inside the workspace root before reading or writing.
2. Reject ".." traversal explicitly even after resolution — depth of defense, not cleverness.
3. Never follow symlinks out of the root; treat a symlinked escape as a hard error.
4. Relative paths in agent tools are resolved against the workspace, never the process cwd.
5. Log the refused path (truncated) when a containment check fails — it is a signal, not noise.
`,
      },
    ],
  },
  {
    slug: "safe-commands",
    category: "security",
    version: "1.0.0",
    description: "Shell commands run screened and narrow: no rm -rf, no curl|sh, no chained evasion forms.",
    skills: [
      {
        name: "safe-commands",
        body:
          SKILL_HEADER("Safe commands", "The shell is the most dangerous tool in the belt — treat it that way.") +
          `## Rules

1. Prefer argv-array process APIs over shell strings; when a shell is required, keep the command one line and quote variables.
2. Never pipe network input into an interpreter (curl | sh is always refused).
3. Destructive flags (-rf, --force, drop, truncate) need explicit user-visible justification in the task summary.
4. Prefer the project's own scripts (npm run ...) over ad-hoc command chains.
5. Long-running commands get timeouts; a hung process is a failure mode, handle it.
`,
      },
    ],
    hooks: {
      deny: ["rm\\s+-rf\\s+/", "curl[^|]*\\|\\s*(ba)?sh", "wget[^|]*\\|\\s*(ba)?sh", "mkfs", ":(){:\\|:&};:"],
      notify: ["run_command"],
    },
  },
  {
    slug: "dependency-audit",
    category: "security",
    version: "1.0.0",
    description: "New dependencies are justified, pinned, and checked: no floating ranges, no packages that duplicate existing ones.",
    skills: [
      {
        name: "dependency-audit",
        body:
          SKILL_HEADER("Dependency audit", "Every dependency is permanent maintenance — add them like it hurts.") +
          `## Rules

1. Before adding a package, check whether the repo already has one that does the job (bundlers ship a lot).
2. Pin with caret ranges only; never a bare latest, never a git URL without a commit.
3. Prefer tiny, focused, actively-maintained packages; note the weekly downloads and last publish when justifying.
4. After adding, run the install and the test suite — a dep that breaks the build does not get committed.
5. Record why the dependency exists in the task summary so removal later is easy.
`,
      },
    ],
  },
  {
    slug: "log-hygiene",
    category: "security",
    version: "1.0.0",
    description: "Logs are safe by construction: no tokens, no personal data, no full payloads — ids and summaries only.",
    skills: [
      {
        name: "log-hygiene",
        body:
          SKILL_HEADER("Log hygiene", "Logs outlive the request and travel further than you think.") +
          `## Rules

1. Never log tokens, keys, passwords, cookies, or full authorization headers — log their presence, not their value.
2. Personal data (emails, names) is logged as ids unless debugging specifically requires it.
3. Truncate payloads to a bounded length; log shape ("received 42-item array") over content.
4. Use the project's logger with levels — console.log in committed code is a smell.
5. Errors log the stack server-side and a sanitized message to the client.
`,
      },
    ],
  },
  {
    slug: "csrf-origin",
    category: "security",
    version: "1.0.0",
    description: "State-changing endpoints verify origin/method semantics: JSON-only POSTs, origin checks, safe-method discipline.",
    skills: [
      {
        name: "csrf-origin",
        body:
          SKILL_HEADER("CSRF & origin discipline", "A browser will happily send your cookies anywhere — verify who asked.") +
          `## Rules

1. State-changing JSON endpoints reject cross-origin requests (the app's proxy layer does this — do not bypass it with new middleware).
2. GET must stay side-effect free; anything that mutates is POST/PUT/DELETE.
3. SameSite cookie defaults are kept; do not switch cookies to SameSite=None without an explicit reason in the task.
4. Redirects validate destination URLs — open redirects are a vulnerability, not a convenience.
5. File downloads carry Content-Disposition and a fixed content type.
`,
      },
    ],
  },
];
