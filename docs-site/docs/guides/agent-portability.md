---
sidebar_position: 7
---

# Agent-Environment Portability

Orplex is a local-first coding agent: the same codebase must run the same way on a Windows laptop, a Linux server, and inside CI — even though the shell available to the **app at runtime** differs from the shell the **developer** types into. On a typical Windows dev box your terminal is Git Bash (Unix pipes work), but Orplex's own `execSync`/`spawn` calls go through `cmd.exe`, where `mkdir -p`, `$?`, and `gzip` simply do not exist.

This page is the checklist for keeping the codebase portable. Every rule is backed by a real fix that shipped in this repo — the two case studies at the end are the canonical examples.

## The golden rules

1. **Never shell out for filesystem work.** `mkdir -p`, `cp -r`, `rm -rf`, `ln -s`, `touch` are POSIX. Use the `fs/promises` API: `mkdir(p, { recursive: true })`, `cp(src, dst, { recursive: true })`, `rm(p, { recursive: true, force: true })`.
2. **Spawn binaries with argument arrays, never shell strings.** No `pg_dump x | gzip > y` — pipes are shell syntax. Spawn the tool directly and let it do the work (pg_dump has `--compress`; every tool you'd pipe into has a native equivalent).
3. **If you truly must run a shell, branch on `process.platform`.** Pick the shell, the quoting, and the exit-code syntax per platform — see `shell-session.ts`.
4. **Never assume `PATH` ships a binary.** Resolve explicitly (vendored → app-bundled → env override → PATH probe), and vendor what the platform doesn't ship (`scripts/fetch-pgdump.mjs`, wired as a postinstall hook).
5. **Probe binaries with `spawnSync(bin, ["--version"], { windowsHide: true })`** before relying on them; cache the result so a missing binary warns once, not on every call.
6. **Kill process trees per platform.** `kill` (MSYS) cannot signal Windows PIDs; use `taskkill /PID <pid> /T /F` on win32.
7. **Build paths with `path.join`/`path.sep`** — never string-concatenate `/`.
8. **Env vars in npm scripts go through `cross-env`** so `FOO=1 next dev` doesn't break Windows.
9. **Setup scripts must fail soft.** A postinstall that can't reach the network must exit 0 with a warning (and only exit 1 under `--strict` in CI) — never break `npm install`.
10. **Windows binaries carry baggage**: `.exe` suffixes, plus their DLL dependencies (pg_dump needs libpq, libcrypto/libssl, intl, lz4, zstd, zlib…). Vendor the whole closure.

## Case study 1 — `parallel-workspaces`: `mkdir -p` through cmd.exe

**Symptom:** workspace creation crashed on Windows before any git worktree was made.

**Before** (`src/lib/parallel-workspaces/index.ts`):

```ts
// "mkdir -p" is Unix-shell-only and would fail through cmd.exe on Windows
execSync(`mkdir -p "${join(rootDir, ".orplex-workspaces")}"`);
```

**After:**

```ts
// fs API — platform-independent, no shell involved
await mkdir(join(rootDir, ".orplex-workspaces"), { recursive: true });
```

Same repo, same call, zero behavior change on POSIX — but it now works everywhere. The module also layers git via `execFile("git", [...])` (argv array, no shell) and instruments the rare legitimate fallback to a directory copy with `mode: "worktree" | "copy" | "copy-fallback"` so a platform problem is *visible*, not silent.

## Case study 2 — `backup.ts`: `pg_dump | gzip` that crashed every boot

**Symptom:** the daily backup cron threw on every server start on Windows: the command string assumed a POSIX shell, a `gzip` binary on PATH, and sh-style quoting of a database URL that contains spaces and URL parameters.

**Before:**

```ts
execSync(`pg_dump "${dbUrl}" | gzip > "${filepath}"`); // POSIX shell + gzip + pipes
```

**After:**

```ts
const child = spawn(
  pgDump.cmd,
  ["--file", filepath, "--format=custom", "--compress=gzip:6", "--no-password", dbUrl],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
);
```

Direct spawn: no shell to interpret the URL, no `gzip` needed (pg_dump's built-in compression), custom-format output restorable with `pg_restore`. The binary is resolved through a chain — `.localpg/pgbin/` (vendored by postinstall) → embedded-postgres bundle → `PG_BIN` → one cached PATH probe — and every step is surfaced in `GET /api/admin/health`, so a machine where nothing resolves reports `pgDump.available: false` with a setup hint instead of crashing.

## Where the platform branches live

| File | Mechanism |
|---|---|
| `src/lib/shell-session.ts` | `isWin` picks `cmd.exe` vs `/bin/sh`, `& echo %errorlevel%` vs `{ …; } ; echo $?`, `taskkill /T /F` vs `kill` |
| `src/lib/backup.ts` | resolver chain + direct spawn with argv arrays + `windowsHide` |
| `scripts/fetch-pgdump.mjs` | non-Windows exits early ("install postgresql-client"); Windows vendors binaries + DLLs; `--strict` for CI |
| `src/lib/parallel-workspaces/index.ts` | `fs/promises` everywhere; `execFile("git", …)` |
| `scripts/local-db.mjs` | embedded-postgres lifecycle instead of shelling to `pg_ctl` scripts |

## Reviewer checklist

When touching anything that runs a command, writes a file, or resolves a binary:

- [ ] No `execSync`/`exec` with a **string** that contains `|`, `&&`, `;`, `>`, globs, or `mkdir -p`/`rm -rf`/`cp -r`
- [ ] `spawn`/`execFile` use **argv arrays**; flags like `--compress` replace pipes; `windowsHide: true` set
- [ ] If a shell is unavoidable: `process.platform` branch, correct quoting and `$?`/`%errorlevel%` per side
- [ ] Binaries resolved explicitly (vendored → bundled → `*_BIN` env → cached PATH probe), never assumed on PATH
- [ ] Missing-binary path degrades with a **single** warning + admin-visible status, not a crash loop
- [ ] Paths built with `path.join`; npm-script env vars wrapped in `cross-env`; postinstall survives offline
- [ ] A unit test pins the invocation shape (e.g. `backup.test.ts` asserts the spawn args contain no `|` and end with the DB URL)

## Automated enforcement

The rules above are mechanically enforced by a custom ESLint rule — `tools/eslint-rules/no-unix-shell-in-exec.cjs`, wired into `eslint.config.mjs` for the whole repo and run by `npm run lint` (CI's lint-and-typecheck job):

- Flags **string or template-literal arguments** to `exec`/`execSync`/`execFile`/`execFileSync`/`spawn`/`spawnSync` that contain Unix-only shell tokens (`mkdir -p`, `rm -rf`, `cp -r`, pipes, `&&`/`||`, `;`, redirections, `$VAR`, backticks, globs, `~/`).
- Flags **`shell: true`** option objects (split into argv arrays, or platform-branch with an inline `eslint-disable` + reason).
- Tracks which identifiers actually refer to `child_process` — static, default/namespace, `require`, require-destructure, and `await import(...)` — so regex `.exec()` and the **agent's dynamic guarded-shell commands** (`exec(command, …)` where `command` is a variable) are never false positives.
- `electron/main.ts` is allowlisted via the rule's `allowFiles` option — its port-kill logic is deliberately platform-branched (`netstat | findstr` vs `lsof | xargs kill`).

Tested by a RuleTester suite (`src/lib/__tests__/no-unix-shell-in-exec.test.ts`, 25 cases); it already paid rent by catching a conditional-hook error in `ArtifactCard.tsx` during its first full run.

## Test gates

`npm run typecheck`, `npm run lint` (including the portability rule), the jest suite (which mocks `child_process`/`fs` and asserts invocation shapes — see `src/lib/__tests__/backup.test.ts`), and `npm run audit` all run platform-independently in CI. On Windows also run `npm run db:restore-drill` after schema changes — it exercises pg_dump → pg_restore → live-database comparison, the most portability-sensitive path in the repo.
