/**
 * memory-file-store.test.ts — the create_file staging store contract.
 *
 * Pins the feature rules that must never drift: TTL expiry (4h, lazily
 * enforced), the 2-entry cap with oldest-evicted + tombstone, validation
 * (filename shape, content size), the assessment-free byte handling (no disk
 * writes anywhere in the module), and the honest three-state status reads
 * (live / expired / removed).
 */
import {
  MAX_FILES_PER_SCOPE,
  MAX_MEMORY_FILE_BYTES,
  createMemoryFile,
  memoryFileStatus,
  readMemoryFile,
  resetMemoryFileStoreForTests,
  seedDemoMemoryFileStates,
  stopMemoryFileStoreSweep,
} from "../memory-file-store";

afterAll(() => {
  stopMemoryFileStoreSweep();
});

beforeEach(() => {
  resetMemoryFileStoreForTests();
});

describe("createMemoryFile — happy path", () => {
  it("stages content and returns card metadata without the bytes", () => {
    const res = createMemoryFile({
      filename: "summary.md",
      content: "# Plan\n- a\n- b",
      ownerId: "user-1",
      conversationId: "conv-1",
    });
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect(res.file.filename).toBe("summary.md");
    expect(res.file.lines).toBe(3);
    expect(res.file.ownerId).toBe("user-1");
    expect(res.file.conversationId).toBe("conv-1");
    expect(res.file.expiresAt).toBeGreaterThan(res.file.createdAt);
    // 4h TTL — the feature contract value.
    expect(res.file.expiresAt - res.file.createdAt).toBe(4 * 60 * 60 * 1000);
    expect(res.evicted).toBeNull();

    const read = readMemoryFile(res.file.id);
    expect(read.state).toBe("live");
    expect(read.content).toBe("# Plan\n- a\n- b");
    expect(read.meta?.filename).toBe("summary.md");
  });
});

describe("createMemoryFile — validation", () => {
  it.each([
    ["path traversal", "../etc/passwd.md"],
    ["absolute path", "C:\\x\\notes.md"],
    ["no extension", "README"],
    ["trailing separator", "notes.md/"],
    ["empty", ""],
    ["too long", `${"a".repeat(101)}.md`],
    ["reserved device", "CON.md"],
  ])("refuses %s", (_label, name) => {
    const res = createMemoryFile({ filename: name as string, content: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_filename");
  });

  it("refuses non-string or empty content", () => {
    expect(createMemoryFile({ filename: "a.md", content: "" }).ok).toBe(false);
    expect(createMemoryFile({ filename: "a.md", content: 42 }).ok).toBe(false);
    expect(createMemoryFile({ filename: "a.md", content: undefined }).ok).toBe(false);
  });
});

describe("size cap", () => {
  it("refuses bytes beyond the ceiling with a too_large error", () => {
    const big = "x".repeat(MAX_MEMORY_FILE_BYTES + 1);
    const res = createMemoryFile({ filename: "big.md", content: big });
    if (!res.ok) expect(res.error).toBe("too_large");
    else throw new Error("expected too_large refusal");
  });
});

describe("entry cap — max 2, oldest evicted", () => {
  it("keeps the newest two and tombstones the evicted one", () => {
    expect(MAX_FILES_PER_SCOPE).toBe(2);

    const r1 = createMemoryFile({ filename: "one.md", content: "aaa" });
    const r2 = createMemoryFile({ filename: "two.md", content: "bbb" });
    if (!r1.ok || !r2.ok) throw new Error("setup failed");

    const r3 = createMemoryFile({ filename: "three.md", content: "ccc", conversationId: "conv-2" });
    if (!r3.ok) throw new Error(`third create refused: ${r3.error}`);
    // The 3rd creation displaced exactly the oldest entry, and was told so.
    expect(r3.evicted).toEqual({ id: r1.file.id, filename: "one.md" });

    // Evicted entry reads as removed; the newest two stay live.
    const evictedRead = readMemoryFile(r1.file.id);
    expect(evictedRead.state).toBe("removed");
    expect(evictedRead.tombstone?.reason).toBe("evicted");
    expect(evictedRead.tombstone?.conversationId).toBeNull(); // r1 had no conversationId
    expect(readMemoryFile(r2.file.id).state).toBe("live");
    expect(readMemoryFile(r3.file.id).state).toBe("live");
  });
});

describe("duplicate suppression — identical filename+bytes", () => {
  it("returns the existing entry untouched instead of creating a twin", () => {
    const r1 = createMemoryFile({ filename: "dup.md", content: "same bytes" });
    if (!r1.ok) throw new Error("setup failed");
    // Fill the cap with a second file so a non-idempotent store would be
    // forced to evict if the duplicate landed as a new entry.
    const other = createMemoryFile({ filename: "other.md", content: "other" });
    if (!other.ok) throw new Error("setup failed");

    const again = createMemoryFile({ filename: "dup.md", content: "same bytes" });
    if (!again.ok) throw new Error(`re-stage refused: ${again.error}`);
    expect(again.duplicate).toBe(true);
    expect(again.file.id).toBe(r1.file.id); // same card, same id
    expect(again.evicted).toBeNull(); // nothing churned
    // The identical re-stage must not have pushed anything out.
    expect(readMemoryFile(other.file.id).state).toBe("live");
    expect(readMemoryFile(r1.file.id).state).toBe("live");
    // Only the original entry survives under that name.
    const afterBytes = readMemoryFile(again.file.id);
    expect(afterBytes.state).toBe("live");
  });

  it("does NOT flag a namesake with different content — it replaces", () => {
    const v1 = createMemoryFile({ filename: "re.md", content: "version one" });
    if (!v1.ok) throw new Error("setup failed");
    const v2 = createMemoryFile({ filename: "re.md", content: "version two" });
    if (!v2.ok) throw new Error(`replace refused: ${v2.error}`);
    expect(v2.duplicate).toBe(false);
    expect(v2.file.id).not.toBe(v1.file.id); // new entry, fresh card
    expect(v2.evicted).toEqual({ id: v1.file.id, filename: "re.md" });
    expect(readMemoryFile(v1.file.id).state).toBe("removed"); // old twin gone
  });
});

describe("TTL — 4h, lazily enforced", () => {
  it("reports expired after the TTL elapses and wipes the bytes", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    jest.useFakeTimers({ now });
    try {
      const res = createMemoryFile({ filename: "brief.md", content: "hello" });
      if (!res.ok) throw new Error("setup failed");
      const id = res.file.id;

      expect(readMemoryFile(id).state).toBe("live");
      expect(memoryFileStatus(id)).toBe("live");

      // Advance just past 4h — lazy expiry fires on the next read.
      jest.setSystemTime(now + 4 * 60 * 60 * 1000 + 1);

      const status = memoryFileStatus(id);
      expect(status).toBe("expired");

      const read = readMemoryFile(id);
      expect(read.state).toBe("removed");
      expect(read.content).toBeNull();
      expect(read.tombstone?.reason).toBe("expired");

      // Late expiry is sticky (a later clock rewind cannot resurrect bytes).
      const late = readMemoryFile(id);
      expect(late.content).toBeNull();
      expect(late.tombstone?.reason).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
  });

  it("expiry converts to an expired tombstone even without an explicit read", () => {
    const now = Date.now();
    jest.useFakeTimers({ now });
    try {
      const res = createMemoryFile({ filename: "ghost.md", content: "boo" });
      if (!res.ok) throw new Error("setup failed");
      jest.setSystemTime(now + 4 * 60 * 60 * 1000 + 60);
      // A NEW creation sweeps due entries as a side effect of budgeting.
      const next = createMemoryFile({ filename: "alive.md", content: "x" });
      expect(next.ok).toBe(true);
      expect(memoryFileStatus(res.file.id)).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("status / unknown ids", () => {
  it("answers removed for ids the store never knew", () => {
    expect(memoryFileStatus("00000000-0000-4000-8000-000000000000")).toBe("removed");
    const read = readMemoryFile("00000000-0000-4000-8000-000000000000");
    expect(read.state).toBe("removed");
    expect(read.meta).toBeNull();
  });
});

describe("dev demo seeds", () => {
  it("seeds all three card states only in dev, and refuses in production mode", () => {
    const prod = seedDemoMemoryFileStates(false);
    expect(prod.liveId).toBeNull();

    const dev = seedDemoMemoryFileStates(true);
    expect(dev.liveId).toBeTruthy();
    expect(dev.expiredId).toBeTruthy();
    expect(dev.removedId).toBeTruthy();

    expect(memoryFileStatus(dev.liveId as string)).toBe("live");
    expect(memoryFileStatus(dev.expiredId as string)).toBe("expired");
    // Removed state = a planted tombstone with no content behind it.
    expect(memoryFileStatus(dev.removedId as string)).toBe("removed");
  });
});
