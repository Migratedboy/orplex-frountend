import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { cleanupOldBackups, getBackupStatus, isBackupConfigured, runBackup } from "@/lib/backup";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/backups — backup availability + history for the admin card.
 * Cheap (no process spawn unless only the PATH candidate remains).
 */
export async function GET() {
  try {
    await requireAdmin();
    const status = await getBackupStatus();
    return NextResponse.json({
      success: true,
      ...status,
      // Actionable hint for the operator when pg_dump is missing.
      setupHint: status.pgDump.available
        ? null
        : "Run `npm run db:pgdump` (downloads pg_dump into .localpg/pgbin) or set PG_BIN to a Postgres bin directory.",
    });
  } catch (err) {
    const status = err instanceof Error && err.message === "Unauthorized" ? 401 : err instanceof Error && err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}

/**
 * POST /api/admin/backups — trigger a manual backup (+ rotation) right now.
 * Returns the created file, or an error payload with a setup hint when
 * pg_dump/DB is not configured so the UI can point the operator at the fix.
 */
export async function POST() {
  try {
    await requireAdmin();
    if (!isBackupConfigured()) {
      return NextResponse.json(
        {
          success: false,
          error: "pg_dump not available",
          setupHint: "Run `npm run db:pgdump` (downloads pg_dump into .localpg/pgbin) or set PG_BIN to a Postgres bin directory.",
        },
        { status: 503 },
      );
    }
    // runBackup (not fullBackupCycle) so the response can carry the created
    // file; fullBackupCycle returns void.
    const backup = await runBackup();
    if (!backup) {
      return NextResponse.json(
        { success: false, error: "Backup failed — see server logs (is the database running?)" },
        { status: 500 },
      );
    }
    await cleanupOldBackups();
    const status = await getBackupStatus();
    return NextResponse.json({ success: true, backup, status });
  } catch (err) {
    const status = err instanceof Error && err.message === "Unauthorized" ? 401 : err instanceof Error && err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
