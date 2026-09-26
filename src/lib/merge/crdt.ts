// merge/crdt.ts — Line-level CRDT for concurrent workspace edits.
//
// Design: every LINE carries a stable identity (peerId, lamport). Documents
// are sequences of Line atoms; edits are insert/delete (tombstone) ops that
// commute — merging two concurrent docs in either order yields the SAME
// sequence. This is an LSEQ-style allocation (lines allocate fractional-ish
// positions inside their left/right boundary pairs) simplified to "insert
// after a known line id", which is sufficient at checkpoint granularity:
// concurrent checkpoints share a common ancestor, so every insert anchors to
// a line both sides know.
//
// Convergence contract (property-tested): for any two docs derived from a
// common doc via arbitrary op sets, mergeDocs(a, b) === mergeDocs(b, a).
//
// Tombstones: deleted lines are kept as tombstones (invisible in text) so
// concurrent inserts AT a deleted position still anchor correctly. GC drops
// tombstones older than the last checkpoint boundary.
//
// Zero deps, pure, serial per file — the laptop budget is one file at a time
// with a 5k-ops cap; the caller (sync) enforces the file-size envelope.

export type PeerId = string;
export type LineId = string; // `${peer}:${lamport}`

export interface Line {
  id: LineId;
  /** Stable content hash input — actual text lives in the doc's text map. */
  text: string;
  /** Tombstoned lines stay for concurrent-insert anchoring. */
  deleted: boolean;
  /** Insertion anchor: after this line (null = head). */
  after: LineId | null;
  /** Logical timestamp for ordering concurrent inserts at the same anchor. */
  lamport: number;
  peer: PeerId;
}

export interface CrdtDoc {
  lines: Line[]; // document order INCLUDING tombstones (tombstones prune on read)
  lamport: number;
  peer: PeerId;
}

export type Op =
  | { kind: "insert"; id: LineId; after: LineId | null; text: string; lamport: number; peer: PeerId }
  | { kind: "delete"; id: LineId; lamport: number; peer: PeerId };

let lamportCounter = 0;

/** A fresh doc for a peer, seeded with plain text (one line per atom). */
export function createDoc(peer: PeerId, text: string): CrdtDoc {
  lamportCounter = 0;
  const doc: CrdtDoc = { lines: [], lamport: 0, peer };
  const rawLines = text.length === 0 ? [] : text.split("\n");
  let after: LineId | null = null;
  rawLines.forEach((t) => {
    lamportCounter += 1;
    doc.lamport = Math.max(doc.lamport, lamportCounter);
    const line: Line = {
      id: `${peer}:${doc.lamport}`,
      text: t,
      deleted: false,
      after,
      lamport: doc.lamport,
      peer,
    };
    doc.lines.push(line);
    after = line.id;
  });
  return doc;
}

function findLine(doc: CrdtDoc, id: LineId | null): Line | null {
  if (id === null) return null;
  return doc.lines.find((l) => l.id === id) ?? null;
}

/** Apply one op. Ops are idempotent — replaying is a no-op. */
export function applyOp(doc: CrdtDoc, op: Op): void {
  doc.lamport = Math.max(doc.lamport, op.lamport) + 1;
  if (op.kind === "insert") {
    if (findLine(doc, op.id)) return; // idempotent
    // Anchor may be unknown (deep history compacted) → append at tail.
    const anchorExists = op.after === null || findLine(doc, op.after) !== null;
    const line: Line = {
      id: op.id,
      text: op.text,
      deleted: false,
      after: anchorExists ? op.after : lastLiveId(doc),
      lamport: op.lamport,
      peer: op.peer,
    };
    doc.lines.push(line);
    return;
  }
  // delete: tombstone (idempotent). The tombstone records the DELETE's
  // lamport (not the insert's) so GC watermarks reason about deletion time.
  const line = findLine(doc, op.id);
  if (line && !line.deleted) {
    line.deleted = true;
    line.lamport = Math.max(line.lamport, op.lamport);
  }
}

function lastLiveId(doc: CrdtDoc): LineId | null {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    if (!doc.lines[i].deleted) return doc.lines[i].id;
  }
  return null;
}

/**
 * Rebuild document order from the anchor graph. Deterministic tie-break for
 * concurrent inserts at the same anchor: higher lamport first, then peer id
 * (lexicographic) — BOTH sides run the same comparator, hence convergence.
 * Unreachable lines (anchor chains broken by GC/compaction) append at the
 * end in id order — visible, deterministic, never silently dropped.
 */
export function docText(doc: CrdtDoc): string {
  const byAnchor = new Map<LineId | null, Line[]>();
  for (const l of doc.lines) {
    const arr = byAnchor.get(l.after) ?? [];
    arr.push(l);
    byAnchor.set(l.after, arr);
  }
  for (const arr of byAnchor.values()) {
    arr.sort((a, b) => b.lamport - a.lamport || (a.peer < b.peer ? -1 : 1));
  }
  const out: string[] = [];
  const visited = new Set<LineId>();
  const walk = (anchor: LineId | null) => {
    const arr = byAnchor.get(anchor);
    if (!arr) return;
    for (const l of arr) {
      if (visited.has(l.id)) continue;
      visited.add(l.id);
      if (!l.deleted) out.push(l.text);
      walk(l.id);
    }
  };
  walk(null);
  // Orphans (whose anchor LINE no longer exists in the doc — GC/compaction):
  // deterministic id order, dead last. Existence is checked against the doc's
  // actual line ids, NOT bucket keys (a filtered-out line still leaves a
  // stale bucket key behind via someone's `after` reference). Each orphan
  // walks its own subtree so children stay visible and ordered.
  const lineIds = new Set(doc.lines.map((l) => l.id));
  const orphans = doc.lines
    .filter((l) => !visited.has(l.id) && l.after !== null && !lineIds.has(l.after))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const l of orphans) {
    if (visited.has(l.id)) continue;
    visited.add(l.id);
    if (!l.deleted) out.push(l.text);
    walk(l.id);
  }
  return out.join("\n");
}

/** All ops that produce `doc` (from empty) — the sync wire format. */
export function toOps(doc: CrdtDoc): Op[] {
  return doc.lines.map((l) =>
    l.deleted
      ? ({ kind: "delete", id: l.id, lamport: l.lamport, peer: l.peer } as Op)
      : ({ kind: "insert", id: l.id, after: l.after, text: l.text, lamport: l.lamport, peer: l.peer } as Op)
  );
}

/**
 * Merge two docs derived from a common ancestor: union of line sets, both
 * sides' deletes honored. The merged line array is CANONICALLY ordered by id
 * so both merge orders build identical docs — the walk in docText is then
 * pure function of the (id-unique) line set, which is what makes
 * merge(a,b) === merge(b,a) a structural fact, not a hope.
 */
export function mergeDocs(a: CrdtDoc, b: CrdtDoc): CrdtDoc {
  const byId = new Map<string, Line>();
  for (const l of a.lines) byId.set(l.id, { ...l });
  for (const l of b.lines) {
    const mine = byId.get(l.id);
    if (mine) {
      // Deletion on either side wins (remove-wins tombstone), and the line's
      // lamport takes the MAX — doc A may never have seen B's delete op, so
      // its copy still carries the insert lamport. Without the max, the two
      // merge orders would sort tombstones differently and diverge.
      mine.deleted = mine.deleted || l.deleted;
      mine.lamport = Math.max(mine.lamport, l.lamport);
    } else {
      byId.set(l.id, { ...l });
    }
  }
  const lines = [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
  return { lines, lamport: Math.max(a.lamport, b.lamport), peer: a.peer };
}

/**
 * Drop tombstones older than the watermark — CHAIN-SAFELY: a tombstone is
 * only dropped when nothing anchors to it (leaf tombstones first, cascading).
 * Removing a tombstone that live lines anchor to would orphan them.
 */
export function gcTombstones(doc: CrdtDoc, watermark: number): number {
  let dropped = 0;
  for (;;) {
    const anchored = new Set(doc.lines.filter((l) => !l.deleted).map((l) => l.after));
    const anchoredTombstones = new Set(doc.lines.filter((l) => l.deleted && anchored.has(l.id)).map((l) => l.id));
    const before = doc.lines.length;
    doc.lines = doc.lines.filter((l) => {
      if (!l.deleted) return true;
      if (l.lamport > watermark) return true; // too recent to GC
      if (anchoredTombstones.has(l.id)) return true; // still an anchor for others
      return false;
    });
    dropped += before - doc.lines.length;
    if (before === doc.lines.length) break; // cascade settled
  }
  return dropped;
}

/** Diff two plain texts into CRDT ops relative to a common base doc. */
export function diffToOps(base: CrdtDoc, newText: string, peer: PeerId): Op[] {
  const ops: Op[] = [];
  const baseLive = docText(base).split("\n");
  const baseIds = base.lines.filter((l) => !l.deleted).map((l) => l.id);
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  const nextLamport = () => ++base.lamport;

  // LCS-free line diff: align by longest common prefix/suffix (checkpoint-
  // granularity edits cluster at one region; full LCS is overkill here).
  let pre = 0;
  while (pre < baseLive.length && pre < newLines.length && baseLive[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < baseLive.length - pre &&
    suf < newLines.length - pre &&
    baseLive[baseLive.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) suf++;

  // Delete replaced middle lines (by id).
  for (let i = pre; i < baseLive.length - suf; i++) {
    ops.push({ kind: "delete", id: baseIds[i], lamport: nextLamport(), peer });
  }
  // Insert new middle lines anchored to the line before the hunk. When the
  // hunk sits at the head (nothing before it), anchor to the first SURVIVING
  // line after the hunk — inserts at a shared anchor order by (lamport, peer)
  // deterministically, so a head-anchored chain stays correct.
  let anchor: LineId | null = pre > 0 ? baseIds[pre - 1] : baseIds[pre + (baseLive.length - suf - pre)] ?? null;
  let anchorIsAfter = pre > 0;
  if (anchor !== null && !anchorIsAfter) {
    // Head hunk with a known successor: insert AFTER the successor would put
    // us below it — instead we mark these as head-anchored by using null and
    // letting the (lamport, peer) order place them above the successor. The
    // successor itself anchors on the last of our inserts is NOT expressible;
    // head-hunks therefore chain from null in lamport order, which the
    // comparator sorts deterministically.
    anchor = null;
  }
  for (let i = pre; i < newLines.length - suf; i++) {
    nextLamport();
    const id = `${peer}:${base.lamport}`;
    ops.push({ kind: "insert", id, after: anchorIsAfter ? anchor : null, text: newLines[i], lamport: base.lamport, peer });
    anchor = id;
    anchorIsAfter = true;
  }
  return ops;
}
