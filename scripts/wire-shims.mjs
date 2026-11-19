// wire-shims.mjs — replace app modules that now live in @orplex/sdk with a
// one-line re-export, so every existing "@/lib/..." import keeps working and
// any single module can be rolled back by restoring its file from git.
//
// Only modules that the SDK actually ships are shimmed: the skip list is the
// app-bound set (Prisma, NextAuth, Next request context) that stays in the app.
import fs from "node:fs";
import path from "node:path";

const APP_LIB = "D:/orplex/src/lib";
const LIST = "D:/orplex-sdk/scripts/closure.txt";
const DRY = process.argv.includes("--dry-run");

// Deliberately app-side: needs Prisma/NextAuth/Next request context.
const KEEP = new Set(["auth.ts", "prisma.ts", "plugin-library/domain.ts", "mcp-auth.ts"]);

const modules = fs
  .readFileSync(LIST, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((rel) => !KEEP.has(rel));

const shims = [];
const skipped = [];

for (const rel of modules) {
  const appFile = path.join(APP_LIB, rel);
  if (!fs.existsSync(appFile)) {
    skipped.push(`${rel} (missing in app)`);
    continue;
  }
  const current = fs.readFileSync(appFile, "utf8");
  if (current.includes("@orplex/sdk/lib/")) {
    skipped.push(`${rel} (already a shim)`);
    continue;
  }
  const sdkPath = rel.replace(/\.ts$/, "");
  const body = `// Shim — this module now lives in @orplex/sdk.
//
// The app keeps importing "@/lib/${sdkPath}" unchanged, so the extraction is
// reversible per module: delete this file and restore it from git to roll back.
// Implementations, fixes and tests for it belong in the SDK repo.
export * from "@orplex/sdk/lib/${sdkPath}";
`;
  shims.push(rel);
  if (!DRY) fs.writeFileSync(appFile, body, "utf8");
}

console.log(`${DRY ? "would shim" : "shimmed"} ${shims.length} modules`);
if (skipped.length) console.log(`skipped: ${skipped.join(", ")}`);
if (DRY) console.log(shims.join("\n"));
