// Regression tests for backup.ts: pg_dump resolution precedence (vendored →
// embedded → PG_BIN → PATH probe), direct no-shell spawn with --file +
// gzip compression, missing-binary resilience, partial-file cleanup, and the
// admin status snapshot.
//
// resolvePgDump caches its PATH probe per process, so every test that touches
// resolution imports a FRESH module instance (jest.resetModules) and wires
// its own mocks — no cross-test cache coupling.
jest.mock("child_process", () => ({ spawn: jest.fn(), spawnSync: jest.fn() }));
jest.mock("fs", () => ({ existsSync: jest.fn() }));
jest.mock("fs/promises", () => ({
  readdir: jest.fn(),
  unlink: jest.fn(),
  stat: jest.fn(),
  mkdir: jest.fn(),
  readFile: jest.fn(),
}));

import { EventEmitter } from "events";
import { join } from "path";
// Static import for the PURE helpers (retention config/eval) — no fs/child_process
// touch, so the mocked-deps instance from the top of the registry works fine.
import * as m_backup from "../backup";

const DB_URL = "postgresql://postgres:postgres@localhost:5433/orplex";
const OLD_ENV = { ...process.env };

// Platform-aware: backup.ts picks pg_dump vs pg_dump.exe by process.platform,
// so the expected binary name must match the same check (CI runs on Linux).
const PG_DUMP_BIN = `pg_dump${process.platform === "win32" ? ".exe" : ""}`;
const VENDORED = join(process.cwd(), ".localpg", "pgbin", PG_DUMP_BIN);
const EMBEDDED = join(
  process.cwd(),
  "node_modules",
  "@embedded-postgres",
  `${process.platform}-x64`,
  "native",
  "bin",
  PG_DUMP_BIN,
);

interface BackupMocks {
  backup: typeof import("../backup");
  spawnMock: jest.Mock;
  spawnSyncMock: jest.Mock;
  existsSyncMock: jest.Mock;
  mkdirMock: jest.Mock;
  statMock: jest.Mock;
  unlinkMock: jest.Mock;
  readdirMock: jest.Mock;
  readFileMock: jest.Mock;
}

async function freshBackup(): Promise<BackupMocks> {
  jest.resetModules();
  const [cp, fsMod, fsp, backup] = await Promise.all([
    import("child_process"),
    import("fs"),
    import("fs/promises"),
    import("../backup"),
  ]);
  const spawnMock = cp.spawn as unknown as jest.Mock;
  const spawnSyncMock = cp.spawnSync as unknown as jest.Mock;
  const existsSyncMock = fsMod.existsSync as unknown as jest.Mock;
  const mkdirMock = fsp.mkdir as unknown as jest.Mock;
  const statMock = fsp.stat as unknown as jest.Mock;
  const unlinkMock = fsp.unlink as unknown as jest.Mock;
  const readdirMock = fsp.readdir as unknown as jest.Mock;
  const readFileMock = fsp.readFile as unknown as jest.Mock;

  // Sane defaults so every fresh instance behaves; individual tests override.
  existsSyncMock.mockReturnValue(false);
  mkdirMock.mockResolvedValue(undefined);
  unlinkMock.mockResolvedValue(undefined);
  // mtime relative to NOW — a fixed date silently went stale once real time
  // passed it and flipped retention warnings on for every test.
  statMock.mockResolvedValue({ size: 2048, mtime: new Date(Date.now() - 2 * 3_600_000) });
  readdirMock.mockResolvedValue([]);
  // Default: vendor status file absent (most tests don't care about it).
  readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  spawnSyncMock.mockReturnValue({ status: 0, stdout: Buffer.from("pg_dump (PostgreSQL) 18.0") });

  return {
    backup,
    spawnMock,
    spawnSyncMock,
    existsSyncMock,
    mkdirMock,
    statMock,
    unlinkMock,
    readdirMock,
    readFileMock,
  };
}

/** spawn replacement whose fake child emits events on the next microtask. */
function fakeSpawnOn(spawnMock: jest.Mock, behavior: (child: EventEmitter & { stderr: EventEmitter }) => void): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    // Real spawn exposes stderr synchronously so runBackup can attach its
    // collector before any events fire.
    child.stderr = new EventEmitter();
    queueMicrotask(() => behavior(child));
    return child;
  });
}

beforeEach(() => {
  process.env.DATABASE_URL = DB_URL;
  delete process.env.PG_BIN;
});

afterAll(() => {
  process.env = { ...OLD_ENV };
});

describe("pg_dump resolution precedence", () => {
  it("prefers the vendored .localpg/pgbin binary", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    await m.backup.runBackup();

    expect(m.spawnMock.mock.calls[0][0]).toBe(VENDORED);
  });

  it("falls back to the embedded-postgres bundle when nothing is vendored", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockImplementation((p) => String(p) === EMBEDDED);
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    await m.backup.runBackup();

    expect(m.spawnMock.mock.calls[0][0]).toBe(EMBEDDED);
  });

  it("honors the PG_BIN override when the bundles are missing", async () => {
    const m = await freshBackup();
    process.env.PG_BIN = "C:\\Program Files\\PostgreSQL\\16\\bin";
    m.existsSyncMock.mockImplementation((p) => String(p).startsWith(process.env.PG_BIN!));
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    await m.backup.runBackup();

    expect(m.spawnMock.mock.calls[0][0]).toBe(join(process.env.PG_BIN, PG_DUMP_BIN));
  });

  it("uses PATH only after a successful --version probe", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(false);
    m.spawnSyncMock.mockReturnValue({ status: 0, stdout: Buffer.from("pg_dump (PostgreSQL) 18.0") });
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    await m.backup.runBackup();

    expect(m.spawnSyncMock).toHaveBeenCalledWith("pg_dump", ["--version"], expect.anything());
    expect(m.spawnMock.mock.calls[0][0]).toBe("pg_dump");
  });

  it("returns null without spawning when no pg_dump exists anywhere", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(false);
    m.spawnSyncMock.mockReturnValue({ status: 1, error: new Error("not found") });

    await expect(m.backup.runBackup()).resolves.toBeNull();
    expect(m.spawnMock).not.toHaveBeenCalled();
  });
});

describe("runBackup invocation shape", () => {
  it("returns null without DATABASE_URL and never spawns", async () => {
    delete process.env.DATABASE_URL;
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);

    await expect(m.backup.runBackup()).resolves.toBeNull();
    expect(m.spawnMock).not.toHaveBeenCalled();
  });

  it("spawns pg_dump directly with --file + gzip compression (no shell pipe)", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    m.mkdirMock.mockResolvedValue(undefined);
    m.statMock.mockResolvedValue({ size: 2048, mtime: new Date() });
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    const result = await m.backup.runBackup();

    expect(result).not.toBeNull();
    expect(result!.size).toBe(2048);

    const [cmd, args, opts] = m.spawnMock.mock.calls[0] as [string, string[], { windowsHide: boolean; env?: NodeJS.ProcessEnv }];
    expect(cmd).toBe(VENDORED);
    expect(args[0]).toBe("--file");
    expect(args[1]).toMatch(/backups[\\/]orplex-backup-.*\.dump$/);
    expect(args).toContain("--compress=gzip:6");
    // SECURITY: the DB password must never appear in argv (process-list
    // visible) — it travels via PGPASSWORD, and the URL is stripped.
    expect(args[args.length - 1]).toBe("postgresql://postgres@localhost:5433/orplex");
    expect(args.join(" ")).not.toContain("postgres:postgres");
    expect(opts.env?.PGPASSWORD).toBe("postgres");
    // Pipe syntax would only survive inside a shell string — there is none.
    expect(args.join(" ")).not.toContain("|");
    expect(opts.windowsHide).toBe(true);
  });

  it("removes the partial file and reports a short message on pg_dump failure", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    m.mkdirMock.mockResolvedValue(undefined);
    m.unlinkMock.mockResolvedValue(undefined);
    fakeSpawnOn(m.spawnMock, (child) => {
      child.stderr.emit("data", "pg_dump: error: connection refused");
      child.emit("close", 1);
    });

    const result = await m.backup.runBackup();

    expect(result).toBeNull();
    expect(m.unlinkMock).toHaveBeenCalledWith(expect.stringMatching(/orplex-backup-.*\.dump$/));
  });
});

describe("getBackupStatus (admin card)", () => {
  it("reports availability + source and an empty history when no dumps exist", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    m.readdirMock.mockResolvedValue([]);

    const status = await m.backup.getBackupStatus();

    expect(status.pgDump).toEqual({ available: true, source: "vendored" });
    expect(status.databaseConfigured).toBe(true);
    expect(status.lastBackup).toBeNull();
    expect(status.backupCount).toBe(0);
  });

  it("lists only orplex-backup dumps, newest first, with totals", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true); // vendored → deterministic source
    m.readdirMock.mockResolvedValue([
      "orplex-backup-2026-09-24T10-00-00.dump",
      "unrelated.txt",
      "orplex-backup-2026-09-25T10-00-00.dump",
    ]);
    m.statMock.mockImplementation(async (p: string) => ({
      size: String(p).includes("09-25") ? 300 : 100,
      mtime: new Date(String(p).includes("09-25") ? "2026-09-25T10:00:00Z" : "2026-09-24T10:00:00Z"),
    }));

    const status = await m.backup.getBackupStatus();

    expect(status.backupCount).toBe(2);
    expect(status.lastBackup!.filename).toBe("orplex-backup-2026-09-25T10-00-00.dump");
    expect(status.lastBackup!.sizeBytes).toBe(300);
    expect(status.totalSizeBytes).toBe(400);
  });

  it("reports the missing source and never throws when nothing is configured", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(false);
    m.spawnSyncMock.mockReturnValue({ status: 1, error: new Error("not found") });
    m.readdirMock.mockRejectedValue(new Error("ENOENT"));

    const status = await m.backup.getBackupStatus();

    expect(status.pgDump).toEqual({ available: false, source: "missing" });
    expect(status.backupCount).toBe(0);
    expect(status.lastBackup).toBeNull();
  });
});

describe("backup outcome recording (health endpoint)", () => {
  it("records ok + filename on a successful backup", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    await m.backup.runBackup();

    const runtime = m.backup.getBackupRuntime();
    expect(runtime.lastBackupOutcome).toBe("ok");
    expect(runtime.lastBackupMessage).toMatch(/orplex-backup-.*\.dump \(0\.0 MB\)/);
    expect(runtime.lastBackupError).toBeNull();
    expect(runtime.lastBackupAt).not.toBeNull(); // stamped by runBackup on success
  });

  it("records failed + error text when pg_dump exits nonzero", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    fakeSpawnOn(m.spawnMock, (child) => {
      child.stderr.emit("data", "pg_dump: error: connection refused");
      child.emit("close", 1);
    });

    await m.backup.runBackup();

    const runtime = m.backup.getBackupRuntime();
    expect(runtime.lastBackupOutcome).toBe("failed");
    expect(runtime.lastBackupMessage).toContain("connection refused");
  });

  it("records unconfigured when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const m = await freshBackup();

    await expect(m.backup.runBackup()).resolves.toBeNull();

    const runtime = m.backup.getBackupRuntime();
    expect(runtime.lastBackupOutcome).toBe("unconfigured");
    expect(runtime.lastBackupMessage).toContain("DATABASE_URL");
  });

  it("records unconfigured when no pg_dump binary resolves", async () => {
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(false);
    m.spawnSyncMock.mockReturnValue({ status: 1, error: new Error("not found") });

    await expect(m.backup.runBackup()).resolves.toBeNull();
    expect(m.spawnMock).not.toHaveBeenCalled();

    const runtime = m.backup.getBackupRuntime();
    expect(runtime.lastBackupOutcome).toBe("unconfigured");
    expect(runtime.lastBackupMessage).toContain("db:pgdump");
  });
});

describe("backup cron heartbeat", () => {
  it("startBackupCron marks the cron running and ticks; stop clears it", async () => {
    jest.useFakeTimers();
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    fakeSpawnOn(m.spawnMock, (child) => child.emit("close", 0));

    m.backup.startBackupCron(1000);
    let runtime = m.backup.getBackupRuntime();
    expect(runtime.cronRunning).toBe(true);
    expect(runtime.lastCronTickAt).not.toBeNull();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    runtime = m.backup.getBackupRuntime();
    expect(runtime.lastCronTickAt).not.toBeNull();

    m.backup.stopBackupCron();
    expect(m.backup.getBackupRuntime().cronRunning).toBe(false);
    jest.useRealTimers();
  });
});

describe("getVendorStatus (fetch-pgdump status file)", () => {
  it("parses a present status file", async () => {
    const m = await freshBackup();
    m.readFileMock.mockResolvedValue(
      JSON.stringify({
        status: "vendored",
        message: "pg_dump (PostgreSQL) 18.0 client binaries vendored into .localpg/pgbin/",
        pgDumpVersion: "pg_dump (PostgreSQL) 18.0",
        fetchedAt: "2026-09-25T09:00:00.000Z",
      }),
    );

    const vendor = await m.backup.getVendorStatus();

    expect(vendor.present).toBe(true);
    expect(vendor.status).toBe("vendored");
    expect(vendor.pgDumpVersion).toContain("18.0");
    expect(vendor.fetchedAt).toBe("2026-09-25T09:00:00.000Z");
  });

  it("reports present:false when the script never ran", async () => {
    const m = await freshBackup();

    const vendor = await m.backup.getVendorStatus();

    expect(vendor.present).toBe(false);
    expect(vendor.status).toBe("unknown");
  });

  it("maps a failed run with its error message", async () => {
    const m = await freshBackup();
    m.readFileMock.mockResolvedValue(
      JSON.stringify({
        status: "failed",
        message: "download failed: HTTP 503",
        pgDumpVersion: null,
        fetchedAt: "2026-09-25T09:00:00.000Z",
      }),
    );

    const vendor = await m.backup.getVendorStatus();

    expect(vendor.present).toBe(true);
    expect(vendor.status).toBe("failed");
    expect(vendor.message).toContain("HTTP 503");
  });

  it("survives malformed JSON without throwing", async () => {
    const m = await freshBackup();
    m.readFileMock.mockResolvedValue('{"status": "failed", "mess');

    const vendor = await m.backup.getVendorStatus();

    expect(vendor.present).toBe(true); // file exists — it's just unreadable
    expect(vendor.status).toBe("unknown");
    expect(vendor.message).toContain("not valid JSON");
  });
});

describe("backupRetentionConfig (env parsing)", () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("defaults to 25h stale limit and no size cap", () => {
    delete process.env.ORPLEX_BACKUP_MAX_STALE_HOURS;
    delete process.env.ORPLEX_BACKUP_MAX_TOTAL_MB;

    const cfg = m_backup.backupRetentionConfig();

    expect(cfg).toEqual({ maxStaleHours: 25, maxTotalBytes: 0 });
  });

  it("honors custom values", () => {
    process.env.ORPLEX_BACKUP_MAX_STALE_HOURS = "48";
    process.env.ORPLEX_BACKUP_MAX_TOTAL_MB = "500";

    const cfg = m_backup.backupRetentionConfig();

    expect(cfg).toEqual({ maxStaleHours: 48, maxTotalBytes: 500 * 1024 * 1024 });
  });

  it("falls back to defaults on junk, zero, and negative values", () => {
    for (const [hours, mb] of [
      ["abc", ""],
      ["0", "0"],
      ["-5", "-10"],
      ["NaN", "NaN"],
    ] as const) {
      process.env.ORPLEX_BACKUP_MAX_STALE_HOURS = hours;
      process.env.ORPLEX_BACKUP_MAX_TOTAL_MB = mb;

      expect(m_backup.backupRetentionConfig()).toEqual({ maxStaleHours: 25, maxTotalBytes: 0 });
    }
  });
});

describe("evaluateBackupRetention (pure)", () => {
  const BASE = { maxStaleHours: 25, maxTotalBytes: 0 };
  const NOW = new Date("2026-09-25T15:00:00.000Z");

  it("warns stale when the newest backup exceeds the hour limit", () => {
    const staleAt = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();

    const warnings = m_backup.evaluateBackupRetention({
      lastBackupAt: staleAt,
      totalSizeBytes: 100,
      now: NOW,
      config: BASE,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("stale");
    expect(warnings[0].message).toContain("30.0h");
    expect(warnings[0].message).toContain("25h");
  });

  it("does not warn when the newest backup is fresh", () => {
    const freshAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

    expect(
      m_backup.evaluateBackupRetention({ lastBackupAt: freshAt, totalSizeBytes: 100, now: NOW, config: BASE }),
    ).toEqual([]);
  });

  it("warns size when total exceeds a configured cap (and only then)", () => {
    const cfg = { maxStaleHours: 25, maxTotalBytes: 100 * 1024 * 1024 };
    const freshAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

    const over = m_backup.evaluateBackupRetention({
      lastBackupAt: freshAt,
      totalSizeBytes: 150 * 1024 * 1024,
      now: NOW,
      config: cfg,
    });
    expect(over).toHaveLength(1);
    expect(over[0].kind).toBe("size");
    expect(over[0].message).toContain("150 MB");
    expect(over[0].message).toContain("100 MB");

    expect(m_backup.evaluateBackupRetention({ lastBackupAt: freshAt, totalSizeBytes: 99 * 1024 * 1024, now: NOW, config: cfg })).toEqual([]);
  });

  it("no backups at all produces no warnings (visible as \"No backups yet\")", () => {
    expect(m_backup.evaluateBackupRetention({ lastBackupAt: null, totalSizeBytes: 0, now: NOW, config: BASE })).toEqual([]);
  });

  it("stale and size warnings can fire together", () => {
    const staleAt = new Date(NOW.getTime() - 40 * 3_600_000).toISOString();
    const cfg = { maxStaleHours: 25, maxTotalBytes: 50 * 1024 * 1024 };

    const warnings = m_backup.evaluateBackupRetention({
      lastBackupAt: staleAt,
      totalSizeBytes: 80 * 1024 * 1024,
      now: NOW,
      config: cfg,
    });

    expect(warnings.map((w) => w.kind)).toEqual(["stale", "size"]);
  });

  it("getBackupStatus embeds retention info (limits + empty warnings by default)", async () => {
    delete process.env.ORPLEX_BACKUP_MAX_STALE_HOURS;
    delete process.env.ORPLEX_BACKUP_MAX_TOTAL_MB;
    const m = await freshBackup();
    m.existsSyncMock.mockReturnValue(true);
    // Filename derived from NOW so the "< 25h old" assumption holds forever
    // (a fixed 2026 date silently expired once real time passed it).
    const freshName = `orplex-backup-${new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.dump`;
    m.readdirMock.mockResolvedValue([freshName]);

    const status = await m.backup.getBackupStatus();

    expect(status.retention.maxStaleHours).toBe(25);
    expect(status.retention.maxTotalMB).toBe(0);
    expect(status.retention.warnings).toEqual([]); // backup is 2h old — well inside the 25h limit
  });
});
