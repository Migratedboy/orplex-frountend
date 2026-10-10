/**
 * lowMemoryNote — the failure-path RAM note.
 *
 *  1. low memory reported → note with the exact percentage
 *  2. memory fine / endpoint down / fetch throwing → null (message ships
 *     unchanged — the note can never break a failure path)
 */

import { lowMemoryNote } from "../memory-note";

describe("lowMemoryNote", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns the percentage note when the server reports low memory", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ usedPercent: 96, lowMemory: true }),
    }) as unknown as typeof fetch;
    await expect(lowMemoryNote()).resolves.toBe("Low memory: system RAM at 96% used");
  });

  it("returns null when memory is fine", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ usedPercent: 41, lowMemory: false }),
    }) as unknown as typeof fetch;
    await expect(lowMemoryNote()).resolves.toBeNull();
  });

  it("returns null when the endpoint answers non-2xx", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(lowMemoryNote()).resolves.toBeNull();
  });

  it("returns null when the payload has no usable percentage", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lowMemory: true }),
    }) as unknown as typeof fetch;
    await expect(lowMemoryNote()).resolves.toBeNull();
  });

  it("returns null when fetch throws (no server / Jest)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    await expect(lowMemoryNote()).resolves.toBeNull();
  });
});
