import {
  serializeWrites,
  normalizeWritePath,
  clearWriteQueueForTests,
} from "../write-queue";

beforeEach(() => {
  clearWriteQueueForTests();
});

describe("write queue", () => {
  it("serializes concurrent writes to the same file in call order", async () => {
    const order: string[] = [];
    const gate = { release: () => {} };
    let blocked = new Promise<void>((resolve) => (gate.release = resolve));

    const first = serializeWrites(["a.ts"], async () => {
      await blocked;
      order.push("first");
    });
    const second = serializeWrites(["a.ts"], async () => {
      order.push("second");
    });

    // `second` must not run while the first is still blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    gate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs writes to different files in parallel", async () => {
    const order: string[] = [];
    const gate = { release: () => {} };
    const blocked = new Promise<void>((resolve) => (gate.release = resolve));

    const slow = serializeWrites(["slow.ts"], async () => {
      await blocked;
      order.push("slow");
    });
    const fast = serializeWrites(["fast.ts"], async () => {
      order.push("fast");
    });

    await fast;
    expect(order).toEqual(["fast"]);
    gate.release();
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("treats path-separator variants of the same file as one queue", async () => {
    const order: string[] = [];
    const first = serializeWrites(["src\\a.ts"], async () => {
      order.push("first");
    });
    const second = serializeWrites(["src/a.ts"], async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps the queue flowing when a write throws", async () => {
    const order: string[] = [];
    const failing = serializeWrites(["x.ts"], async () => {
      order.push("failing");
      throw new Error("disk error");
    });
    const next = serializeWrites(["x.ts"], async () => {
      order.push("next");
    });
    await expect(failing).rejects.toThrow("disk error");
    await next;
    expect(order).toEqual(["failing", "next"]);
  });

  it("propagates the fn's return value", async () => {
    await expect(serializeWrites(["y.ts"], async () => 42)).resolves.toBe(42);
  });
});
