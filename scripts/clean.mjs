// clean.mjs — Out-of-process deep clean for state the in-process janitor
// must NEVER touch: .next/dev holds Turbopack's live task database and is
// written DURING server startup, so only a script that runs while the server
// is STOPPED can delete it safely (an in-process sweep crashes Turbopack —
// observed live, see janitor.ts).
//
// Windows quirk: even after the server exits, handles on .next/dev/lock (and
// occasionally SST chunks) can linger for seconds, making a plain recursive
// rm fail with EPERM/EBUSY. We therefore retry the whole-tree rm with
// backoff, then fall back to deleting children one by one (skipping files
// that stay locked) before removing the directory itself.
//
// Usage: npm run clean        (server must be stopped)
//        npm run clean -- --force   (skip the running-server check)

import { existsSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const force = process.argv.includes("--force");

// rm attempts: 6 tries with growing delays (total ~7s) — enough for Windows
// to release handles after a stopped server.
const RM_ATTEMPTS = 6;
const RM_DELAYS_MS = [150, 300, 600, 1000, 2000, 3000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portHasListener(port) {
  // win32: netstat | findstr; POSIX: try a connection via /dev/tcp
  try {
    if (platform() === "win32") {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
      return out.split("\n").some((l) => l.includes(`:${port} `) && l.includes("LISTENING"));
    }
    const net = await import("node:net");
    return await new Promise((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      s.on("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
      setTimeout(() => {
        s.destroy();
        resolve(false);
      }, 500);
    });
  } catch {
    return false;
  }
}

/** rm with retry/backoff; returns true when the target is gone. */
async function rmWithRetry(target) {
  for (let attempt = 0; attempt < RM_ATTEMPTS; attempt++) {
    if (!existsSync(target)) return true;
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      // fall through to the delay and retry
    }
    if (!existsSync(target)) return true;
    await sleep(RM_DELAYS_MS[attempt] ?? 1000);
  }
  return !existsSync(target);
}

/**
 * Best-effort fallback: delete children individually (retrying each a few
 * times), then rmdir the parent. Files that remain locked are skipped and
 * reported — Next regenerates everything on the next boot.
 */
async function rmBestEffort(target) {
  const skipped = [];
  let entries = [];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    skipped.push(`${target} (readdir: ${err?.code || err?.message})`);
    return skipped;
  }
  for (const entry of entries) {
    const child = join(target, entry.name);
    if (await rmWithRetry(child)) continue;
    if (entry.isDirectory()) {
      // Recurse one level for stubborn subdirectories before giving up.
      try {
        const sub = await readdir(child);
        for (const name of sub) await rmWithRetry(join(child, name));
        await rmdir(child).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    if (existsSync(child)) skipped.push(child.replace(ROOT, ""));
  }
  await rmdir(target).catch(() => {});
  return skipped;
}

async function cleanTarget(label, target) {
  if (!existsSync(target)) {
    console.log(`[clean] ${label} — not present, skipping`);
    return;
  }
  if (await rmWithRetry(target)) {
    console.log(`[clean] removed ${label}`);
    return;
  }
  console.warn(`[clean] ${label} — recursive rm failed (locked files?), trying file-by-file…`);
  const skipped = await rmBestEffort(target);
  if (!existsSync(target)) {
    console.log(`[clean] removed ${label} (after per-file fallback)`);
  } else if (skipped.length > 0) {
    console.warn(`[clean] ${label} — ${skipped.length} locked item(s) left (Next rebuilds them):`);
    for (const s of skipped.slice(0, 10)) console.warn(`[clean]   skipped ${s}`);
  } else {
    console.warn(`[clean] ${label} — still present but empty-ish; next boot will regenerate it`);
  }
}

async function main() {
  if (!force && (await portHasListener(5000))) {
    console.error("[clean] Dev server appears to be RUNNING on :5000 — stop it first (this script deletes its live state).");
    console.error("[clean] Override with: npm run clean -- --force");
    process.exit(1);
  }

  await cleanTarget(".next/dev", join(ROOT, ".next", "dev"));
  await cleanTarget(".next/cache", join(ROOT, ".next", "cache"));
  console.log("[clean] done — next `npm run dev` rebuilds from scratch.");
}

main().catch((err) => {
  console.error("[clean] failed:", err?.message || err);
  process.exit(1);
});
