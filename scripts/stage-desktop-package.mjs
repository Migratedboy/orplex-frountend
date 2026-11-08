#!/usr/bin/env node
// stage-desktop-package.mjs — build a MINIMAL staging tree for electron-builder.
//
// Why this exists: electron-builder scans the package manager's production
// dependency tree before packaging ("searching for node modules pm=npm"). In
// this monorepo that tree is enormous (hundreds of duplicate versions) and the
// scan runs for many minutes before it starts copying anything — meanwhile the
// app it is looking for does not exist. Nothing in the packaged app needs it:
// `output: "standalone"` already traced every runtime dependency into
// .next/standalone/node_modules, and the Electron main process loads Next's
// server.js directly (no `next` CLI, no repo node_modules).
//
// So we stage ONLY what ships:
//   electron-dist/         compiled Electron main process
//   electron/app-config.json + electron/assets/*   runtime config + icons
//   .next/standalone/      self-contained Next server (deps included)
// and hand electron-builder a dependencies-free package.json, which makes the
// dependency scan instant (there is nothing to collect).
//
// Source stays untouched: staging happens in its own tree, never over the
// repo's own files.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// The allowlist (what may ship) lives in electron/package-allowlist.ts, so it
// is unit-tested with the rest of the desktop code. It is compiled to
// electron-dist/ by `npm run electron:build:main`, which runs before this
// script in the electron:dist chain.
const require = createRequire(import.meta.url);
let allowlist;
try {
  allowlist = require(path.join(root, "electron-dist", "package-allowlist.js"));
} catch {
  console.error("[stage] FATAL: electron-dist/package-allowlist.js missing — run `npm run electron:build:main` first.");
  process.exit(1);
}

// Staged INSIDE the repo (not the OS temp dir) so the electron-builder
// invocation can point at it with a repo-relative --projectDir on every
// platform (a %TEMP% path in an npm script is Windows-only).
const stage = path.join(root, ".desktop-package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Compiled Electron main process (electron:build:main -> electron-dist/).
if (!existsSync(path.join(root, "electron-dist", "main.js"))) {
  console.error("[stage] FATAL: electron-dist/main.js missing — run electron:build:main.");
  process.exit(1);
}
cpSync(path.join(root, "electron-dist"), path.join(stage, "electron-dist"), { recursive: true });

// 2. Runtime config + assets, keeping the electron/ layout the main process
//    resolves at boot (resources/app/electron/app-config.json).
cpSync(path.join(root, "electron", "app-config.json"), path.join(stage, "electron", "app-config.json"), { recursive: true });
cpSync(path.join(root, "electron", "assets"), path.join(stage, "electron", "assets"), { recursive: true });

// 2b. The NSIS hook named by build.nsis.include (electron/nsis/installer.nsh).
//     electron-builder resolves `include` against buildResourcesDir
//     (<projectDir>/build) or the project dir, so the staged tree needs the file
//     at the SAME repo-relative path — it is not part of `files` and would
//     otherwise be missing, failing the package step with "cannot find
//     specified resource". This file is what stops an update from relaunching
//     the app through the Start Menu shortcut (see electron/nsis/installer.nsh).
//     It lives outside build/ on purpose: build/ is gitignored, and a fix that
//     cannot be committed is a fix that silently never ships.
const nsisInclude = path.join(root, "electron", "nsis", "installer.nsh");
if (!existsSync(nsisInclude)) {
  console.error("[stage] FATAL: electron/nsis/installer.nsh missing — the NSIS relaunch fix would not ship.");
  process.exit(1);
}
mkdirSync(path.join(stage, "electron", "nsis"), { recursive: true });
cpSync(nsisInclude, path.join(stage, "electron", "nsis", "installer.nsh"));

// 3. The standalone Next server (self-contained; includes its node_modules).
//    dereference: the standalone tree contains SYMLINKED packages (@prisma/
//    client -> .prisma/client-<hash>, playwright browsers). Copying links
//    verbatim breaks on Windows and would ship dangling targets, so resolve
//    them to real files here.
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("[stage] FATAL: .next/standalone/server.js missing — run npm run build.");
  process.exit(1);
}

// 3a. PRUNE the standalone tree before copying it.
//
//     Next's file tracing (Turbopack) copies the WHOLE project into
//     .next/standalone whenever a route handler touches the filesystem with a
//     dynamic path — the build prints "Dynamic filesystem access causes tracing
//     of the whole project" 18 times. Shipping that tree verbatim put into the
//     installer: the repo's .env (DATABASE_URL + provider API keys — main.ts
//     documents that a packaged app must NEVER ship one), the PREVIOUS release
//     installer (1 GB), a duplicate 556 MB Electron runtime (including the
//     stock electron.exe that poisons the taskbar icon), the coverage report,
//     the docs site and the source tree. The 3.3 GB payload then broke the
//     release build outright: "failed creating mmap of ...nsis.7z" — makensis
//     is a 32-bit process and cannot map a file larger than 2 GB.
//
//     The allowlist keeps the server the app runs and the dependencies that
//     server loads — nothing else.
function pruneStandaloneTree(dir) {
  const removed = [];

  const topPlan = allowlist.planStandalonePrune(readdirSync(dir));
  for (const name of topPlan.drop) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }

  const nodeModules = path.join(dir, "node_modules");
  if (existsSync(nodeModules)) {
    const nmPlan = allowlist.planNodeModulesPrune(readdirSync(nodeModules));
    for (const name of nmPlan.drop) {
      rmSync(path.join(nodeModules, name), { recursive: true, force: true });
      removed.push(`node_modules/${name}`);
    }

    // Orphaned `prisma generate` temp files (14 × 18.4 MB were sitting here).
    const prismaClient = path.join(nodeModules, ".prisma", "client");
    if (existsSync(prismaClient)) {
      const prismaPlan = allowlist.planPrismaClientPrune(readdirSync(prismaClient));
      for (const name of prismaPlan.drop) {
        rmSync(path.join(prismaClient, name), { recursive: true, force: true });
        removed.push(`node_modules/.prisma/client/${name}`);
      }
    }
  }
  return removed;
}

const pruned = pruneStandaloneTree(standalone);
if (pruned.length) {
  console.log(`[stage] pruned ${pruned.length} entr(y/ies) from the standalone tree (${pruned.slice(0, 8).join(", ")}${pruned.length > 8 ? ", …" : ""})`);
}

cpSync(standalone, path.join(stage, ".next", "standalone"), {
  recursive: true,
  dereference: true,
  verbatimSymlinks: false,
});

// 4. A package.json with NO dependencies — this is what makes electron-builder
//    skip the monorepo dependency scan. Everything else (id, name, version,
//    icons, publish target) is carried over unchanged so the updater feed and
//    installer identity stay exactly the same.
const out = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description || "Orplex Code",
  author: pkg.author || { name: "Orplex" },
  main: "electron-dist/main.js",
  private: true,
  dependencies: {},
  build: { ...pkg.build, directories: { ...(pkg.build?.directories || {}), output: path.join(root, pkg.build?.directories?.output || "release") } },
};
writeFileSync(path.join(stage, "package.json"), JSON.stringify(out, null, 2));

// 5. HARD GUARD: the staged tree is exactly what electron-builder packages.
//    If a secret file is in there, the installer ships it to every user — so
//    fail the build here rather than discover it after the release.
function collectFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

const stagedFiles = collectFiles(stage);
const leaks = allowlist.findLeakFiles(stagedFiles);
if (leaks.length) {
  console.error(`[stage] FATAL: ${leaks.length} file(s) that must never ship are in the staged package:`);
  for (const leak of leaks.slice(0, 20)) console.error(`  ${leak}`);
  console.error("[stage] A shipped .env exposes the database password and the provider API keys.");
  process.exit(1);
}
console.log(`[stage] guard OK — ${stagedFiles.length} staged files, no secret files`);

console.log(`[stage] staged -> ${stage}`);
console.log(`[stage] output dir -> ${out.build.directories.output}`);
console.log("[stage] OK");