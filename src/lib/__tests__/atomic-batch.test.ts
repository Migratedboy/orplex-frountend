/**
 * atomic-batch.test.ts — Phase 3 all-or-nothing EditOp application.
 *
 * The centerpiece is the scripted-sequence integration test: three ops, the
 * SECOND fails, and the test proves op 1 was rolled back (content restored)
 * and the result is ok:false — the exact guarantee master-prompt.ts already
 * promises for batch_edit but native-tools.ts:803-809 does not keep.
 *
 * Everything runs against an in-memory EditIO, which is why the IO is
 * injected: rollback ordering is the thing under test, not the filesystem.
 */
import { applyEditOpsAtomic, type EditIO } from "../reliability/atomic-batch";
import type { EditOp } from "../reliability/edit-ops";
import { contentHash } from "../reliability/hash";

/** In-memory EditIO with an operation log (scripted-sequence assertions). */
class MemoryIO implements EditIO {
  files = new Map<string, string>();
  log: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.files.set(p, c);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async writeFile(path: string, content: string): Promise<boolean> {
    this.log.push(`write:${path}`);
    this.files.set(path, content);
    return true;
  }
  async deleteFile(path: string): Promise<boolean> {
    this.log.push(`delete:${path}`);
    return this.files.delete(path);
  }
  async moveFile(from: string, to: string): Promise<boolean> {
    this.log.push(`move:${from}->${to}`);
    const content = this.files.get(from);
    if (content === undefined) return false;
    this.files.set(to, content);
    this.files.delete(from);
    return true;
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

describe("applyEditOpsAtomic — scripted sequence (3 ops, 2nd fails)", () => {
  it("rolls op 1 back and reports ok:false when op 2 refuses", async () => {
    const io = new MemoryIO({ "a.txt": "alpha", "keep.txt": "keep" });
    const ops: EditOp[] = [
      { op: "replace_text", path: "a.txt", oldText: "alpha", newText: "ALPHA" },
      // Op 2 refuses: keep.txt exists and expectedAbsence forbids clobbering.
      { op: "create_file", path: "keep.txt", content: "clobbered", expectedAbsence: true },
      // Op 3 must never run.
      { op: "delete_file", path: "a.txt" },
    ];

    const r = await applyEditOpsAtomic(ops, io);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("already exists");
      expect(r.error).toContain("op 2 of 3");
      expect(r.error).toContain("rolled back 1 earlier op(s)");
      expect(r.rolledBack).toHaveLength(1);
      expect(r.rolledBack[0].op.op).toBe("replace_text");
    }
    // Op 1 was rolled back: the file is byte-identical to its pre-batch state.
    expect(io.files.get("a.txt")).toBe("alpha");
    // Op 2 never overwrote, op 3 never deleted.
    expect(io.files.get("keep.txt")).toBe("keep");
    expect(io.log.filter((l) => l === "delete:a.txt")).toHaveLength(0);
  });
});

describe("applyEditOpsAtomic — occurrence semantics", () => {
  it("refuses exactly_one when oldText matches MORE than once (the String.replace bug)", async () => {
    const io = new MemoryIO({ "b.txt": "x = 1; y = x;" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "x", newText: "z", occurrence: "exactly_one" }],
      io,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("matches 2 times");
      expect(r.error).toContain("exactly_one");
    }
    // Nothing was replaced — the silent first-match pick is refused, not taken.
    expect(io.files.get("b.txt")).toBe("x = 1; y = x;");
  });

  it("defaults to exactly_one when occurrence is omitted", async () => {
    const io = new MemoryIO({ "b.txt": "aa aa" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "aa", newText: "bb" }],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.get("b.txt")).toBe("aa aa");
  });

  it("applies exactly_one when there is exactly one match", async () => {
    const io = new MemoryIO({ "b.txt": "x = 1; y = 2;" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "x", newText: "z" }],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("b.txt")).toBe("z = 1; y = 2;");
  });

  it("replaces ALL non-overlapping matches under occurrence:'all'", async () => {
    const io = new MemoryIO({ "b.txt": "x x x" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "x", newText: "yz", occurrence: "all" }],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("b.txt")).toBe("yz yz yz");
  });

  it("replaces only the first match under occurrence:'first'", async () => {
    const io = new MemoryIO({ "b.txt": "x x x" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "x", newText: "q", occurrence: "first" }],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("b.txt")).toBe("q x x");
  });

  it("treats newText literally ($& must not expand — String.replace would)", async () => {
    const io = new MemoryIO({ "b.txt": "keep this" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "keep this", newText: "price: $&" }],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("b.txt")).toBe("price: $&");
  });

  it("fails when oldText is not found at all", async () => {
    const io = new MemoryIO({ "b.txt": "nothing here" });
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "b.txt", oldText: "missing", newText: "x" }],
      io,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("oldText not found");
  });
});

describe("applyEditOpsAtomic — expectedHash (stale-read detection)", () => {
  it("refuses the edit with a clear message when the file hash does not match", async () => {
    const io = new MemoryIO({ "c.txt": "current content" });
    const stale = contentHash("what the model read earlier");
    const r = await applyEditOpsAtomic(
      [{ op: "replace_text", path: "c.txt", oldText: "current", newText: "NEW", expectedHash: stale }],
      io,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("hash mismatch for c.txt");
      expect(r.error).toContain(stale);
      expect(r.error).toContain(contentHash("current content"));
      expect(r.error).toContain("changed since it was last read");
    }
    expect(io.files.get("c.txt")).toBe("current content");
  });

  it("applies the edit when the hash matches", async () => {
    const io = new MemoryIO({ "c.txt": "current content" });
    const r = await applyEditOpsAtomic(
      [
        {
          op: "replace_text",
          path: "c.txt",
          oldText: "current",
          newText: "NEW",
          expectedHash: contentHash("current content"),
        },
      ],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("c.txt")).toBe("NEW content");
  });

  it("checks the hash on delete_file and move_file too", async () => {
    const io = new MemoryIO({ "d.txt": "D", "m.txt": "M" });
    const bad = await applyEditOpsAtomic(
      [{ op: "delete_file", path: "d.txt", expectedHash: "00000000" }],
      io,
    );
    expect(bad.ok).toBe(false);
    expect(io.files.has("d.txt")).toBe(true);

    const good = await applyEditOpsAtomic(
      [{ op: "move_file", from: "m.txt", to: "m2.txt", expectedHash: contentHash("M") }],
      io,
    );
    expect(good.ok).toBe(true);
    expect(io.files.get("m2.txt")).toBe("M");
  });
});

describe("applyEditOpsAtomic — rollback of every op kind", () => {
  it("deletes a file that a rolled-back create had created", async () => {
    const io = new MemoryIO();
    const r = await applyEditOpsAtomic(
      [
        { op: "create_file", path: "new.txt", content: "fresh" },
        { op: "replace_text", path: "missing.txt", oldText: "a", newText: "b" },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.has("new.txt")).toBe(false);
    if (!r.ok) expect(r.rolledBack.map((e) => e.op.op)).toEqual(["create_file"]);
  });

  it("restores a file that a rolled-back delete had removed", async () => {
    const io = new MemoryIO({ "d.txt": "precious" });
    const r = await applyEditOpsAtomic(
      [
        { op: "delete_file", path: "d.txt" },
        { op: "insert_at", path: "missing.txt", line: 1, content: "x" },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.get("d.txt")).toBe("precious");
  });

  it("moves a file back when a later op fails", async () => {
    const io = new MemoryIO({ "src.txt": "S", "existing.txt": "E" });
    const r = await applyEditOpsAtomic(
      [
        { op: "move_file", from: "src.txt", to: "dst.txt" },
        { op: "create_file", path: "existing.txt", content: "nope", expectedAbsence: true },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.get("src.txt")).toBe("S");
    expect(io.files.has("dst.txt")).toBe(false);
    expect(io.files.get("existing.txt")).toBe("E");
  });

  it("restores BOTH sides when a move overwrote an existing destination", async () => {
    const io = new MemoryIO({ "src.txt": "S", "dst.txt": "OLD-DST" });
    const r = await applyEditOpsAtomic(
      [
        { op: "move_file", from: "src.txt", to: "dst.txt" },
        { op: "replace_text", path: "missing.txt", oldText: "a", newText: "b" },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.get("src.txt")).toBe("S");
    expect(io.files.get("dst.txt")).toBe("OLD-DST");
  });

  it("rolls back in reverse order across several applied ops", async () => {
    const io = new MemoryIO({ "a.txt": "1", "b.txt": "2" });
    const r = await applyEditOpsAtomic(
      [
        { op: "replace_text", path: "a.txt", oldText: "1", newText: "ONE" },
        { op: "replace_text", path: "b.txt", oldText: "2", newText: "TWO" },
        { op: "delete_file", path: "gone.txt" },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    expect(io.files.get("a.txt")).toBe("1");
    expect(io.files.get("b.txt")).toBe("2");
    if (!r.ok) {
      // Reverse of application: b first, then a.
      expect(r.rolledBack.map((e) => e.op.op)).toEqual(["replace_text", "replace_text"]);
      expect(r.rolledBack.map((e) => e.path)).toEqual(["b.txt", "a.txt"]);
    }
  });

  it("reports an incomplete rollback instead of swallowing it", async () => {
    // writeFile succeeds for op 1's edit but fails for the rollback restore —
    // the error must say the rollback was incomplete.
    class FailingRestoreIO extends MemoryIO {
      private writes = 0;
      override async writeFile(path: string, content: string): Promise<boolean> {
        this.writes += 1;
        if (this.writes > 1) return false;
        return super.writeFile(path, content);
      }
    }
    const io = new FailingRestoreIO({ "a.txt": "1" });
    const r = await applyEditOpsAtomic(
      [
        { op: "replace_text", path: "a.txt", oldText: "1", newText: "ONE" },
        { op: "replace_text", path: "missing.txt", oldText: "a", newText: "b" },
      ],
      io,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ROLLBACK INCOMPLETE");
      expect(r.error).toContain("could not restore a.txt");
      expect(r.rolledBack).toHaveLength(0);
    }
  });
});

describe("applyEditOpsAtomic — happy paths and batches", () => {
  it("applies a all-success sequence and reports every applied entry", async () => {
    const io = new MemoryIO({ "a.txt": "alpha" });
    const r = await applyEditOpsAtomic(
      [
        { op: "replace_text", path: "a.txt", oldText: "alpha", newText: "ALPHA" },
        { op: "create_file", path: "b.txt", content: "bravo" },
        { op: "insert_at", path: "b.txt", line: 1, content: "first line" },
        { op: "move_file", from: "b.txt", to: "c.txt" },
      ],
      io,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.applied.map((e) => e.op.op)).toEqual(["replace_text", "create_file", "insert_at", "move_file"]);
    expect(io.files.get("a.txt")).toBe("ALPHA");
    expect(io.files.get("c.txt")).toBe("first line\nbravo");
  });

  it("flattens a batch op into the sequence (batch is the atomic unit)", async () => {
    const io = new MemoryIO({ "a.txt": "1", "b.txt": "2" });
    const r = await applyEditOpsAtomic(
      [
        {
          op: "batch",
          ops: [
            { op: "replace_text", path: "a.txt", oldText: "1", newText: "ONE" },
            { op: "replace_text", path: "b.txt", oldText: "2", newText: "TWO" },
          ],
        },
      ],
      io,
    );
    expect(r.ok).toBe(true);
    expect(io.files.get("a.txt")).toBe("ONE");
    expect(io.files.get("b.txt")).toBe("TWO");
  });

  it("insert_at splices by 1-based line and refuses out-of-range lines", async () => {
    const io = new MemoryIO({ "l.txt": "l1\nl2" });
    const ok = await applyEditOpsAtomic([{ op: "insert_at", path: "l.txt", line: 2, content: "lx" }], io);
    expect(ok.ok).toBe(true);
    expect(io.files.get("l.txt")).toBe("l1\nlx\nl2");

    const bad = await applyEditOpsAtomic([{ op: "insert_at", path: "l.txt", line: 9, content: "ly" }], io);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("out of range");
  });

  it("reports an IO failure (writeFile → false) as the op failure it is", async () => {
    const io = new MemoryIO();
    io.writeFile = async () => false;
    const r = await applyEditOpsAtomic([{ op: "create_file", path: "x.txt", content: "c" }], io);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("could not write x.txt");
  });
});
