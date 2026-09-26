// fetch-pgdump.mjs — Vendor a pg_dump binary for database backups.
//
// The embedded-postgres bundle ships pg_ctl/initdb but NOT pg_dump, so
// src/lib/backup.ts had nothing to invoke on Windows. This script downloads
// the official EnterpriseDB binaries zip for the SAME major version as the
// embedded server (pg_dump must be >= the server's major version) and
// extracts only pg_dump + its DLL dependencies (~15 MB of the ~300 MB zip)
// into .localpg/pgbin/ — gitignored, survives `npm ci`, deleted by a clean
// checkout (re-run the script then).
//
// Usage:
//     npm run db:pgdump            (or: node scripts/fetch-pgdump.mjs)
//     ORPLEX_PG_DUMP_SKIP_NETWORK=1  → offline: exit 0 without touching network
// Runs automatically on `npm install` (postinstall) so fresh checkouts vendor
// pg_dump without a manual step; the offline-safe exit keeps locked-down
// installs from failing. Non-Windows platforms exit immediately — install the
// distro's postgresql-client (or set PG_BIN) instead.
//
// Resolution order used by backup.ts afterwards:
//   1. .localpg/pgbin/pg_dump.exe   (this script)
//   2. embedded-postgres bundle     (if a future version ships pg_dump)
//   3. ORPLEX/PG_BIN env dir        (self-hosters with a real Postgres install)
//   4. PATH
//
// Resilience mirrors fetch-fonts.mjs: network failures exit 0 with a warning
// (backups then stay "unavailable" in the admin UI) so builds never break on
// a locked-down machine. Pass --strict to make failures exit 1 (CI).
//
// Every outcome also lands in .localpg/pg-dump-status.json (vendored | skipped |
// not-applicable | failed), which src/lib/backup.ts exposes via
// GET /api/admin/health so one endpoint shows the whole backup ops picture —
// the script runs OUTSIDE the server process, so a disk file is the only bridge.
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TARGET_DIR = join(ROOT, ".localpg", "pgbin");
const MARKER = join(TARGET_DIR, "SOURCE.txt");
const STATUS_FILE = join(ROOT, ".localpg", "pg-dump-status.json");

const strict = process.argv.includes("--strict");

// Keep in sync with the @embedded-postgres major version in package.json.
const PG_MAJOR = "18";
const SOURCE_URL = `https://get.enterprisedb.com/postgresql/postgresql-${PG_MAJOR}.0-1-windows-x64-binaries.zip`;

// pg_dump/pg_restore/psql + pg_dumpall.exe need these DLLs from pgsql/bin:
// libpq/libcrypto/libssl plus the intl/lz4/zstd/pthread/zlib stack.
const BIN_FILES = ["pg_dump.exe", "pg_restore.exe", "psql.exe", "pg_dumpall.exe"];
const DLL_FILES = ["libpq.dll", "libcrypto-3-x64.dll", "libssl-3-x64.dll", "libiconv-2.dll", "libintl-9.dll", "liblz4.dll", "libzstd.dll", "libwinpthread-1.dll", "zlib1.dll"];

function writeStatus(status, message, pgDumpVersion = null) {
  try {
    mkdirSync(join(ROOT, ".localpg"), { recursive: true });
    writeFileSync(
      STATUS_FILE,
      `${JSON.stringify({ status, message, pgDumpVersion, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // Status bookkeeping must never break the hook itself.
  }
}

/** SOURCE.txt's last line is the pg_dump version string ("pg_dump (PostgreSQL) 18.0"). */
function markerVersion() {
  try {
    const lines = readFileSync(MARKER, "utf8").split("\n").filter(Boolean);
    return lines.length >= 3 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

function fail(msg) {
  writeStatus("failed", msg);
  console.error(`[pgdump] ${msg}`);
  process.exit(strict ? 1 : 0);
}

async function main() {
  if (process.platform !== "win32") {
    writeStatus("not-applicable", "Non-Windows platform — install postgresql-client (or set PG_BIN)");
    console.log("[pgdump] Non-Windows platform: install the postgresql-client package for your OS (or set PG_BIN). Nothing to vendor.");
    return;
  }
  const present = BIN_FILES.filter((f) => existsSync(join(TARGET_DIR, f)));
  if (present.length === BIN_FILES.length) {
    writeStatus("vendored", "All client binaries already vendored", markerVersion());
    console.log(`[pgdump] All client binaries already vendored at ${TARGET_DIR} — nothing to do (delete the folder to re-fetch).`);
    return;
  }
  if (present.length > 0) {
    console.log(`[pgdump] Partially vendored (${present.join(", ")}) — fetching the missing ones: ${BIN_FILES.filter((f) => !present.includes(f)).join(", ")}`);
  }
  if (process.env.ORPLEX_PG_DUMP_SKIP_NETWORK === "1") {
    writeStatus("skipped", "ORPLEX_PG_DUMP_SKIP_NETWORK=1 — download skipped", markerVersion());
    console.log("[pgdump] ORPLEX_PG_DUMP_SKIP_NETWORK=1 — skipping download (backups will stay unavailable until you run this online).");
    return;
  }

  console.log(`[pgdump] Downloading EnterpriseDB ${PG_MAJOR} binaries (~300 MB, one-time)...`);
  let res;
  try {
    res = await fetch(SOURCE_URL, { redirect: "follow" });
  } catch (err) {
    fail(`download failed (${err.message}) — backups stay unavailable; re-run npm run db:pgdump when online.`);
  }
  if (!res.ok) fail(`download failed: HTTP ${res.status} — backups stay unavailable; re-run npm run db:pgdump later.`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x504b0304) {
    fail("downloaded file is not a zip archive (proxy error page?) — aborting.");
  }

  console.log(`[pgdump] Downloaded ${(buf.length / 1024 / 1024).toFixed(0)} MB — extracting pg_dump + DLLs...`);
  // Dynamic import: a missing/broken jszip must surface as a handled warning
  // (exit 0 by default) — a top-level import would crash the postinstall hook.
  let JSZip;
  try {
    JSZip = (await import("jszip")).default;
  } catch (err) {
    fail(`jszip dependency unavailable (${err.message}) — run npm install, then re-run npm run db:pgdump.`);
  }
  const zip = await JSZip.loadAsync(buf);
  const wanted = new Set([...BIN_FILES, ...DLL_FILES]);
  const extracted = [];

  let dumpVersion = "unknown";

  await mkdir(TARGET_DIR, { recursive: true });
  for (const name of Object.keys(zip.files)) {
    const base = name.split("/").pop();
    if (!name.includes("/bin/") || !wanted.has(base)) continue;
    const data = await zip.files[name].async("nodebuffer");
    await writeFile(join(TARGET_DIR, base), data);
    extracted.push(base);
  }

  const missing = [...wanted].filter((f) => !extracted.includes(f) && !existsSync(join(TARGET_DIR, f)));
  if (missing.length > 0) fail(`zip did not contain expected binaries: ${missing.join(", ")}`);

  // Smoke-test the extracted binaries before declaring victory.
  for (const bin of ["pg_dump.exe", "pg_restore.exe", "psql.exe"]) {
    const probe = spawnSync(join(TARGET_DIR, bin), ["--version"], { windowsHide: true });
    const version = (probe.stdout || "").toString().trim();
    if (probe.error || probe.status !== 0 || !version) {
      await rm(TARGET_DIR, { recursive: true, force: true });
      fail(`extracted ${bin} failed to run${probe.error ? ` (${probe.error.message})` : ""} — removed partial files.`);
    }
    if (bin === "pg_dump.exe") dumpVersion = version;
  }

  await writeFile(MARKER, `source: ${SOURCE_URL}\nfetched: ${new Date().toISOString()}\n${dumpVersion}\n`);
  writeStatus("vendored", `${dumpVersion} client binaries vendored into .localpg/pgbin/`, dumpVersion);
  console.log(`[pgdump] ✓ ${dumpVersion} client binaries vendored into .localpg/pgbin/ — backups and restore drills are available.`);
  console.log(`[pgdump]   Extracted: ${extracted.join(", ")}`);
}

main().catch((err) => fail(err?.message || String(err)));
