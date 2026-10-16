#!/usr/bin/env node
// prepare-standalone.mjs — finish the Next standalone bundle for Electron.
//
// `output: "standalone"` traces the server + its production deps into
// .next/standalone, but it deliberately does NOT copy the two asset trees the
// running app needs at request time:
//   - .next/static  (hashed client JS/CSS — otherwise the UI loads unstyled
//                    and every client chunk 404s)
//   - public/       (favicon, icons, vendored fonts)
// The packaged app serves .next/standalone/server.js, so those two trees must
// live INSIDE it. Verified after copy: a missing tree here is a silently
// broken installer, not a build error — hence the hard checks.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("[prepare-standalone] FATAL: .next/standalone is missing.");
  console.error("  next.config.js must set output: \"standalone\".");
  process.exit(1);
}
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("[prepare-standalone] FATAL: .next/standalone/server.js is missing.");
  process.exit(1);
}

// static -> .next/standalone/.next/static
const staticSrc = path.join(root, ".next", "static");
const staticDst = path.join(standalone, ".next", "static");
if (existsSync(staticSrc)) {
  mkdirSync(path.dirname(staticDst), { recursive: true });
  cpSync(staticSrc, staticDst, { recursive: true });
  console.log("[prepare-standalone] copied .next/static -> standalone/.next/static");
} else {
  console.error("[prepare-standalone] FATAL: .next/static is missing.");
  process.exit(1);
}

// public -> .next/standalone/public
const publicSrc = path.join(root, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, path.join(standalone, "public"), { recursive: true });
  console.log("[prepare-standalone] copied public -> standalone/public");
} else {
  console.warn("[prepare-standalone] WARN: no public/ directory; skipping.");
}

console.log("[prepare-standalone] OK — standalone bundle is shippable.");