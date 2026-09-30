// hardware.test.ts — Watchdog ladder: classification, critical streak +
// hysteresis, pause/resume, and actions firing once per episode. Readings
// are injected so tests never touch real os.freemem().
jest.mock("@/lib/runtime-log", () => ({ recordRuntimeLog: jest.fn() }));
jest.mock("@/lib/runtime-state", () => {
  const state = {
    logs: [],
    executor: {},
    backup: {},
    cron: {},
    workspaces: {},
    hardware: { pressure: "ok", lastCheckAt: null, usedRatio: 0, rssBytes: 0, freememBytes: 0, totalBytes: 0 },
    janitor: { lastSweepAt: null, lastResult: null, running: false },
  };
  return { runtimeState: state };
});

import {
  checkMemoryPressure,
  resetHardwareState,
  onHighPressure,
  onCriticalPressure,
  isClaimsPaused,
  isMemoryPressureHigh,
} from "@/lib/hardware";

function reading(usedRatio: number) {
  const total = 8 * 1024 ** 3;
  return { freememBytes: total * (1 - usedRatio), totalBytes: total, rssBytes: 100 };
}

beforeEach(() => {
  resetHardwareState();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("memory pressure ladder", () => {
  it("classifies ok/elevated/high/critical from the used ratio", async () => {
    expect((await checkMemoryPressure(reading(0.5))).pressure).toBe("ok");
    expect((await checkMemoryPressure(reading(0.75))).pressure).toBe("elevated");
    expect((await checkMemoryPressure(reading(0.86))).pressure).toBe("high");
    expect((await checkMemoryPressure(reading(0.95))).pressure).toBe("critical");
  });

  it("pauses claims at high pressure and resumes on recovery", async () => {
    await checkMemoryPressure(reading(0.9));
    expect(isClaimsPaused()).toBe(true);
    expect(isMemoryPressureHigh()).toBe(true);

    await checkMemoryPressure(reading(0.5));
    expect(isClaimsPaused()).toBe(false);
    expect(isMemoryPressureHigh()).toBe(false);
  });

  it("fires high-pressure actions once per episode, not per tick", async () => {
    const highFn = jest.fn();
    onHighPressure(highFn);

    await checkMemoryPressure(reading(0.86));
    await checkMemoryPressure(reading(0.9));
    await checkMemoryPressure(reading(0.87));

    expect(highFn).toHaveBeenCalledTimes(1);

    // Recovery resets the latch.
    await checkMemoryPressure(reading(0.5));
    await checkMemoryPressure(reading(0.86));
    expect(highFn).toHaveBeenCalledTimes(2);
  });

  it("fires critical actions only after the sustained streak, once per episode", async () => {
    const criticalFn = jest.fn();
    onCriticalPressure(criticalFn);

    await checkMemoryPressure(reading(0.95));
    expect(criticalFn).not.toHaveBeenCalled();

    await checkMemoryPressure(reading(0.95));
    expect(criticalFn).not.toHaveBeenCalled();

    await checkMemoryPressure(reading(0.95));
    expect(criticalFn).toHaveBeenCalledTimes(1);

    // Still critical → latched, no refire.
    await checkMemoryPressure(reading(0.95));
    expect(criticalFn).toHaveBeenCalledTimes(1);

    // Drops to high (not below) → latch persists.
    await checkMemoryPressure(reading(0.86));
    expect(criticalFn).toHaveBeenCalledTimes(1);

    // Full recovery → latch resets → new episode can fire.
    await checkMemoryPressure(reading(0.5));
    await checkMemoryPressure(reading(0.95));
    await checkMemoryPressure(reading(0.95));
    await checkMemoryPressure(reading(0.95));
    expect(criticalFn).toHaveBeenCalledTimes(2);
  });

  it("a single critical blip does not trigger actions", async () => {
    const criticalFn = jest.fn();
    onCriticalPressure(criticalFn);

    await checkMemoryPressure(reading(0.99));
    await checkMemoryPressure(reading(0.6));
    await checkMemoryPressure(reading(0.99));

    expect(criticalFn).not.toHaveBeenCalled();
  });
});
