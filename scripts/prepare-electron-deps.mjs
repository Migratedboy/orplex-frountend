#!/usr/bin/env node
// prepare-electron-deps.mjs — ship the Electron-side runtime dependencies.
//
// The packaged app's asar contains electron-dist/** but NOT node_modules/**
// (that exclusion keeps the bundle small — the Next standalone output brings
// its own server-side deps). The catch: electron-dist/updater.js does
// `require("electron-updater")` at runtime, and that package was never
// copied in — so the in-app updater died with MODULE_NOT_FOUND the moment
// a user pressed "Check for updates".
//
// This copies electron-updater and its transitive runtime closure into
// electron-dist/node_modules/, which the packaging `files` glob already
// includes. The `electron` npm package is deliberately NOT copied: inside a
// packaged app `require("electron")` must resolve to Electron's built-in
// module, and shipping the npm shim would shadow it (the shim only exports
// a path string — electron-updater's HTTP layer would then see
// `require("electron").net` as undefined).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "node_modules");
const targetRoot = path.join(root, "electron-dist", "node_modules");
const ENTRY = "electron-updater";
const SKIP = new Set(["electron"]); // never ship the npm electron shim

function readManifest(name) {
  const manifest = path.join(sourceRoot, name, "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8"));
}

const closure = new Set();
const queue = [ENTRY];
while (queue.length) {
  const name = queue.shift();
  if (closure.has(name) || SKIP.has(name)) continue;
  const manifest = readManifest(name);
  if (!manifest) {
    console.error(`[electron-deps] FATAL: ${name} is not installed.`);
    process.exit(1);
  }
  closure.add(name);
  for (const dep of Object.keys(manifest.dependencies || {})) {
    if (!closure.has(dep)) queue.push(dep);
  }
}

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });

let copied = 0;
let bytes = 0;
for (const name of closure) {
  const from = path.join(sourceRoot, name);
  const to = path.join(targetRoot, name);
  cpSync(from, to, { recursive: true, dereference: true });
  copied++;
}

// A tiny marker so the packaging step can assert the updater really shipped.
writeFileSync(
  path.join(targetRoot, ".orplex-electron-deps.json"),
  JSON.stringify({ entry: ENTRY, packages: [...closure].sort() }, null, 2),
);

console.log(`[electron-deps] copied ${copied} package(s) into electron-dist/node_modules:`);
console.log(`[electron-deps]   ${[...closure].sort().join(", ")}`);
