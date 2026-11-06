/**
 * local-run-store.test.ts — device-local .json mirror for verification runs.
 *
 * The failure it guards (live 2026-11-06): the desktop box's Postgres was
 * down, /api/agent/verify could not persist runs/artifacts, and every
 * verification's evidence vanished. The DB stays primary; this store keeps
 * the data retrievable when the DB is not. Tests run against a temp file via
 * ORPLEX_VERIFY_RUNS_FILE — never the repo's real .orplex/ store.
 */

import os from "node:os";
import path from "node:path";

const tempDir = path.join(os.tmpdir(), `orplex-verify-store-test-${Date.now()}`);
process.env.ORPLEX_VERIFY_RUNS_FILE = path.join(tempDir, "verify-runs.json");

import {
  saveVerifyRunLocally,
  listLocalVerifyRuns,
} from "../local-run-store";

jest.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("local-run-store", () => {
  afterEach(() => {
    // Fresh store per use — ids are random; list assertions use contained ids.
  });

  it("saves a run and reads it back newest-first", () => {
    const a = saveVerifyRunLocally({
      userId: "u1",
      prompt: "Browser verification: /",
      status: "done",
      workspace: "D:\\proj",
      verifyResult: { success: true, consoleErrors: 0, durationMs: 1234 },
      task: { role: "browser", title: "Verify / — PASS" },
      event: { type: "verification", payload: { success: true } },
      artifacts: [{ kind: "screenshot", name: "shot-1.png", mediaType: "image/png", content: "data:image/png;base64,abc" }],
    });
    const b = saveVerifyRunLocally({
      userId: "u2",
      prompt: "Browser verification: /",
      status: "failed",
      workspace: "D:\\proj",
      verifyResult: { success: false, consoleErrors: 3, durationMs: 2000 },
      task: { role: "browser", title: "Verify / — FAIL" },
    });

    expect(a).toMatch(/^local:[0-9a-f]+$/);

    const all = listLocalVerifyRuns();
    expect(all[0].id).toBe(b); // newest first
    expect(all[all.length - 1].id).toBe(a);

    const forU1 = listLocalVerifyRuns("u1");
    expect(forU1).toHaveLength(1);
    expect(forU1[0].artifacts).toHaveLength(1);
    expect(forU1[0].task).toMatchObject({ title: "Verify / — PASS" });
  });

  it("drops oversized artifacts instead of failing the save", () => {
    const id = saveVerifyRunLocally({
      userId: "u1",
      prompt: "verify",
      status: "done",
      workspace: "w",
      verifyResult: { success: true },
      task: {},
      artifacts: [
        { kind: "screenshot", name: "ok.png", mediaType: "image/png", content: "small" },
        { kind: "video", name: "huge.webm", mediaType: "video/webm", content: "x".repeat(5_000_000) },
      ],
    });
    const run = listLocalVerifyRuns("u1").find((r) => r.id === id);
    expect(run?.artifacts.map((a) => a.name)).toEqual(["ok.png"]);
  });
});
