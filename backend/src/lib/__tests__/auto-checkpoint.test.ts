// Auto-checkpoint gate tests — cooldown, cap latch, RAM pause, kill-switch.

import {
  newAutoCheckpointState,
  shouldAutoCheckpoint,
  recordAutoCheckpoint,
  resetAutoCheckpointState,
  accumulateDelta,
  AUTO_CP_COOLDOWN_MS_DEFAULT,
  AUTO_CP_MAX_PER_RUN_DEFAULT,
  AUTO_CP_DELTA_BYTES_DEFAULT,
  autoCpDeltaBytes,
} from "../auto-checkpoint";

describe("auto-checkpoint gate", () => {
  test("first write to a file is always taken", () => {
    const s = newAutoCheckpointState();
    expect(shouldAutoCheckpoint(s, "src/a.ts", 1000, { enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("cooldown suppresses repeated checkpoints for the same file (expensive delta)", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "src/a.ts", 1000);
    accumulateDelta(s, 60 * 1024); // over the cheap-diff threshold
    // 5s later — inside the 15s default cooldown, delta expensive
    expect(shouldAutoCheckpoint(s, "src/a.ts", 6000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "cooldown",
    });
    // 20s later — cooldown expired, taken again
    expect(shouldAutoCheckpoint(s, "src/a.ts", 21_000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("different files are independent under cooldown", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "src/a.ts", 1000);
    expect(shouldAutoCheckpoint(s, "src/b.ts", 2000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("zero cooldown means every write checkpoints (unless capped)", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "src/a.ts", 1000);
    expect(shouldAutoCheckpoint(s, "src/a.ts", 1001, { cooldownMs: 0, maxPerRun: 100, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("per-run cap latches halted and stays latched", () => {
    const s = newAutoCheckpointState();
    for (let i = 0; i < 3; i++) recordAutoCheckpoint(s, `f${i}.ts`, 1000 + i);
    // At cap (3/3): halted
    expect(shouldAutoCheckpoint(s, "new.ts", 5000, { maxPerRun: 3, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "halted-cap",
    });
    // Even a fresh file, much later — the latch holds for the run
    expect(shouldAutoCheckpoint(s, "other.ts", 999_999, { maxPerRun: 3, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "halted-cap",
    });
  });

  test("memory pressure pauses auto checkpoints (RAM guard)", () => {
    const s = newAutoCheckpointState();
    expect(shouldAutoCheckpoint(s, "src/a.ts", 1000, { enabled: true, memoryHigh: true })).toEqual({
      take: false,
      reason: "memory-pressure",
    });
    // And resumes cleanly once pressure clears
    expect(shouldAutoCheckpoint(s, "src/a.ts", 2000, { enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("kill-switch disables entirely", () => {
    const s = newAutoCheckpointState();
    expect(shouldAutoCheckpoint(s, "src/a.ts", 1000, { enabled: false, memoryHigh: false })).toEqual({
      take: false,
      reason: "disabled",
    });
  });

  test("defaults match the 8GB laptop budget", () => {
    expect(AUTO_CP_COOLDOWN_MS_DEFAULT).toBe(15_000);
    expect(AUTO_CP_MAX_PER_RUN_DEFAULT).toBe(20);
  });

  test("resetAutoCheckpointState clears cooldown, count, and latch", () => {
    const s = newAutoCheckpointState();
    for (let i = 0; i < 5; i++) recordAutoCheckpoint(s, `f${i}.ts`, 1000 + i);
    expect(s.countThisRun).toBe(5);
    resetAutoCheckpointState(s);
    expect(s.countThisRun).toBe(0);
    expect(s.halted).toBe(false);
    expect(s.lastAtByFile.size).toBe(0);
    expect(shouldAutoCheckpoint(s, "f0.ts", 2000, { maxPerRun: 5, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("cap honors env override shape (max 1 → second write halted)", () => {
    const s = newAutoCheckpointState();
    expect(shouldAutoCheckpoint(s, "a.ts", 1000, { maxPerRun: 1, enabled: true, memoryHigh: false })).toEqual({ take: true, reason: "take" });
    recordAutoCheckpoint(s, "a.ts", 1000);
    expect(shouldAutoCheckpoint(s, "b.ts", 2000, { maxPerRun: 1, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "halted-cap",
    });
  });

  test("cheap diffs bypass the cooldown (delta under threshold)", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "src/a.ts", 1000); // resets delta to 0
    // 1s later — deep inside the 15s cooldown, but the accumulated delta
    // (2KB of small edits) is far under the 50KB threshold → take anyway.
    accumulateDelta(s, 2048);
    expect(shouldAutoCheckpoint(s, "src/a.ts", 2000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("expensive deltas respect the cooldown (delta at/over threshold)", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "src/a.ts", 1000);
    accumulateDelta(s, 60 * 1024); // over the 50KB threshold
    expect(shouldAutoCheckpoint(s, "src/a.ts", 2000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "cooldown",
    });
    // After the cooldown elapses it goes through regardless of delta
    expect(shouldAutoCheckpoint(s, "src/a.ts", 20_000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("exactly at the threshold is NOT cheap (strict less-than); negative bytes ignored", () => {
    const s = newAutoCheckpointState();
    recordAutoCheckpoint(s, "a.ts", 1000);
    accumulateDelta(s, AUTO_CP_DELTA_BYTES_DEFAULT); // == threshold
    expect(shouldAutoCheckpoint(s, "a.ts", 2000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: false,
      reason: "cooldown",
    });
    // Negative/garbage bytes are ignored (guard, not undo) — delta unchanged
    accumulateDelta(s, -100);
    expect(s.deltaSinceLastCp).toBe(AUTO_CP_DELTA_BYTES_DEFAULT);
    // One byte below the threshold flips to cheap
    const s2 = newAutoCheckpointState();
    recordAutoCheckpoint(s2, "a.ts", 1000);
    accumulateDelta(s2, AUTO_CP_DELTA_BYTES_DEFAULT - 1);
    expect(shouldAutoCheckpoint(s2, "a.ts", 2000, { cooldownMs: 15_000, enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });

  test("delta window resets on every checkpoint, not just per file", () => {
    const s = newAutoCheckpointState();
    accumulateDelta(s, 40 * 1024);
    recordAutoCheckpoint(s, "b.ts", 1000); // checkpoint for a DIFFERENT file
    expect(s.deltaSinceLastCp).toBe(0); // window starts fresh
  });

  test("resetAutoCheckpointState clears the delta window", () => {
    const s = newAutoCheckpointState();
    accumulateDelta(s, 1024);
    resetAutoCheckpointState(s);
    expect(s.deltaSinceLastCp).toBe(0);
  });

  test("delta threshold default is 50KB and env-tunable", () => {
    expect(AUTO_CP_DELTA_BYTES_DEFAULT).toBe(50 * 1024);
    delete process.env.ORPLEX_AUTO_CHECKPOINT_DELTA_BYTES;
    expect(autoCpDeltaBytes()).toBe(50 * 1024);
    process.env.ORPLEX_AUTO_CHECKPOINT_DELTA_BYTES = "1024";
    expect(autoCpDeltaBytes()).toBe(1024);
    process.env.ORPLEX_AUTO_CHECKPOINT_DELTA_BYTES = "-5";
    expect(autoCpDeltaBytes()).toBe(50 * 1024); // invalid → default
    delete process.env.ORPLEX_AUTO_CHECKPOINT_DELTA_BYTES;
  });

  test("cooldown bypass never applies to a file's FIRST checkpoint (always taken anyway)", () => {
    const s = newAutoCheckpointState();
    accumulateDelta(s, 100 * 1024); // even a huge pending delta
    expect(shouldAutoCheckpoint(s, "brand-new.ts", 1000, { enabled: true, memoryHigh: false })).toEqual({
      take: true,
      reason: "take",
    });
  });
});
