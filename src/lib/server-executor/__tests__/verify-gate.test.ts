// verify-gate.test.ts — The global verify-lane mutex: FIFO ordering,
// serialization, rejection isolation, and deterministic per-run ports.
import { withVerifySlot, verifyPortForRun, isVerifySlotFree } from "../verify-gate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withVerifySlot", () => {
  it("serializes concurrent callers (FIFO)", async () => {
    const events: string[] = [];
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
    };
    await Promise.all([
      withVerifySlot(job("a", 20)),
      withVerifySlot(job("b", 5)),
      withVerifySlot(job("c", 1)),
    ]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("a rejecting job does not poison the slot", async () => {
    await expect(withVerifySlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const result = await withVerifySlot(async () => "recovered");
    expect(result).toBe("recovered");
    expect(isVerifySlotFree()).toBe(true);
  });

  it("reports the slot busy while a job runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const p = withVerifySlot(async () => { await gate; });
    await sleep(5);
    expect(isVerifySlotFree()).toBe(false);
    release();
    await p;
    expect(isVerifySlotFree()).toBe(true);
  });
});

describe("verifyPortForRun", () => {
  it("is deterministic and near the base port", () => {
    expect(verifyPortForRun("run-abc")).toBe(verifyPortForRun("run-abc"));
    expect(verifyPortForRun("run-abc")).toBeGreaterThanOrEqual(4310);
    expect(verifyPortForRun("run-abc")).toBeLessThan(4360);
  });

  it("differs across run ids (overwhelmingly)", () => {
    const ports = new Set(Array.from({ length: 30 }, (_, i) => verifyPortForRun(`run-${i}`)));
    expect(ports.size).toBeGreaterThan(5);
  });

  it("respects a custom base", () => {
    expect(verifyPortForRun("x", 5000)).toBeGreaterThanOrEqual(5000);
    expect(verifyPortForRun("x", 5000)).toBeLessThan(5050);
  });
});
