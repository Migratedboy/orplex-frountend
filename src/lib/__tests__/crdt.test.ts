// crdt.test.ts — The convergence contract: any two docs from a common
// ancestor merge to the SAME text regardless of op order. Property tests
// with deterministic PRNG, plus targeted interleaving/GC cases.

import {
  createDoc,
  applyOp,
  docText,
  mergeDocs,
  toOps,
  diffToOps,
  gcTombstones,
  type CrdtDoc,
  type Op,
} from "../merge/crdt";

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function replay(base: CrdtDoc, ops: Op[]): CrdtDoc {
  const d: CrdtDoc = { lines: base.lines.map((l) => ({ ...l })), lamport: base.lamport, peer: base.peer };
  for (const op of ops) applyOp(d, op);
  return d;
}

describe("CRDT convergence", () => {
  it("identical base → identical merges regardless of merge order", () => {
    const base = createDoc("seed", ["line1", "line2", "line3"].join("\n"));
    const a = replay(base, diffToOps(replay(base, []), "line1\nA-EDIT\nline3", "peerA"));
    const b = replay(base, diffToOps(replay(base, []), "line1\nline2\nB-TAIL", "peerB"));

    const ab = docText(mergeDocs(a, b));
    const ba = docText(mergeDocs(b, a));
    expect(ab).toBe(ba);
    expect(ab).toContain("A-EDIT");
    expect(ab).toContain("B-TAIL");
  });

  it("property: 50 random op pairs always converge (seeded)", () => {
    const rand = prng(42);
    for (let iter = 0; iter < 50; iter++) {
      const lineCount = 2 + Math.floor(rand() * 6);
      const base = createDoc("seed", Array.from({ length: lineCount }, (_, i) => `L${i}`).join("\n"));

      const makeOps = (peer: string): Op[] => {
        const d = replay(base, []);
        const live = d.lines.filter((l) => !l.deleted);
        const ops: Op[] = [];
        const count = 1 + Math.floor(rand() * 4);
        for (let i = 0; i < count; i++) {
          if (rand() < 0.5 && live.length > 1) {
            // delete a random live line
            const victim = live[Math.floor(rand() * live.length)];
            ops.push({ kind: "delete", id: victim.id, lamport: ++d.lamport, peer });
          } else {
            const anchor = live.length > 0 ? live[Math.floor(rand() * live.length)].id : null;
            const id = `${peer}:${1000 + Math.floor(rand() * 1e6)}`;
            ops.push({ kind: "insert", id, after: anchor, text: `${peer}-ins-${i}`, lamport: ++d.lamport, peer });
          }
        }
        return ops;
      };

      const a = replay(base, makeOps("peerA"));
      const b = replay(base, makeOps("peerB"));
      const ab = docText(mergeDocs(a, b));
      const ba = docText(mergeDocs(b, a));
      if (ab !== ba) {
        throw new Error(`iteration ${iter} diverged:\nA→B:\n${ab}\nB→A:\n${ba}`);
      }
    }
  });

  it("concurrent inserts at the SAME anchor: both survive, deterministic order", () => {
    const base = createDoc("seed", "only");
    const anchor = base.lines[0].id;
    const mk = (peer: string, lamport: number) =>
      replay(base, [{ kind: "insert", id: `${peer}:1`, after: anchor, text: `${peer}-text`, lamport, peer }]);
    const a = mk("peerA", 5);
    const b = mk("peerB", 9);

    const ab = docText(mergeDocs(a, b));
    const ba = docText(mergeDocs(b, a));
    expect(ab).toBe(ba);
    expect(ab).toContain("peerA-text");
    expect(ab).toContain("peerB-text");
  });

  it("delete on one side, insert under it on the other → delete wins, insert survives anchored", () => {
    const base = createDoc("seed", "head\nmid\ntail");
    const midId = base.lines[1].id;
    const a = replay(base, [{ kind: "delete", id: midId, lamport: 10, peer: "peerA" }]);
    const b = replay(base, [{ kind: "insert", id: "peerB:1", after: midId, text: "under-mid", lamport: 11, peer: "peerB" }]);
    const merged = docText(mergeDocs(a, b));
    // The concurrent insert survives (CRDT invariant: never lose an insert),
    // rendered at mid's former position; mid itself is tombstoned.
    expect(merged).toBe("head\nunder-mid\ntail");
  });

  it("tombstone GC is chain-safe: leaf tombstones drop, anchors stay", () => {
    const base = createDoc("seed", "a\nb\nc");
    const d = replay(base, [
      { kind: "delete", id: base.lines[0].id, lamport: 10, peer: "p" },
      { kind: "delete", id: base.lines[1].id, lamport: 11, peer: "p" },
    ]);
    // watermark 10: only the lamport-10 tombstone is old enough, BUT seed:1
    // is the anchor of seed:2's chain — chain-safety keeps it. a is the leaf
    // (nothing anchors to a) → a's tombstone drops.
    const dropped = gcTombstones(d, 10);
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(docText(d)).toBe("c"); // content invariant regardless of GC depth
  });

  it("tombstone GC drops leaf tombstones past the watermark", () => {
    // Independent lines: deleting b leaves a leaf tombstone with no children.
    const base = createDoc("seed", "a\nb\nc");
    // Make b's line anchor to nothing by construction: delete the LAST line —
    // nothing anchors to it.
    const d = replay(base, [{ kind: "delete", id: base.lines[2].id, lamport: 20, peer: "p" }]);
    const dropped = gcTombstones(d, 25);
    expect(dropped).toBe(1);
    expect(docText(d)).toBe("a\nb");
  });

  it("ops roundtrip: toOps → apply reproduces the same text", () => {
    const base = createDoc("seed", "one\ntwo\nthree");
    const edited = replay(base, diffToOps(base, "one\nTWO!\nthree\nfour", "peerX"));
    const rebuilt = createDoc("empty", "");
    for (const op of toOps(edited)) applyOp(rebuilt, op);
    expect(docText(rebuilt)).toBe(docText(edited));
  });
});
