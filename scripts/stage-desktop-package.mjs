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

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

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

console.log(`[stage] staged -> ${stage}`);
console.log(`[stage] output dir -> ${out.build.directories.output}`);
console.log("[stage] OK");