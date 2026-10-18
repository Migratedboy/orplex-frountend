// reliability/progress-hash.ts — deterministic workspace/gate state hashing
// for the Phase 5 loop & progress guard (R5: "no progress over N steps").
//
// A step counts as progress only when the files on disk AND the gate outcomes
// changed. Both hashes are pure functions of their inputs — same input, same
// hash, every run — so two consecutive snapshots can be compared with `===`.
//
// The hash is FNV-1a, byte-for-byte the same algorithm as compaction.ts
// (hashContent): 32-bit offset basis 0x811c9dc5, prime 0x01000193 via
// Math.imul, length folded into the low bits at the end. Cheap, dependency
// free, and good enough to detect "nothing changed" — its job is equality
// detection, not collision resistance against an adversary.

/**
 * FNV-1a over the text, with the length folded in (matches compaction.ts
 * hashContent exactly). Returns an 8-char lowercase hex string.
 */
export function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h ^ text.length) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic hash of the workspace file set. Accepts a Map or a plain
 * record; keys are sorted before hashing so iteration order never matters.
 * Path and content are length-prefixed so concatenation cannot alias
 * ("ab"+"c" vs "a"+"bc").
 */
export function hashWorkspaceState(files: Map<string, string> | Record<string, string>): string {
  const entries: Array<[string, string]> =
    files instanceof Map ? Array.from(files.entries()) : Object.entries(files);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: string[] = [];
  for (const [path, content] of entries) {
    parts.push(`${path.length}:${path}${content}`);
  }
  return fnv1aHex(parts.join("\n"));
}

export interface GateResultLike {
  lane: string;
  outcome: string;
  newErrors: string[];
}

/**
 * Fingerprint of a verification-lane sweep: the sorted set of
 * (lane, outcome, newErrors). Two steps with the same fingerprint had the
 * SAME gates failing the same way — i.e. no verification progress. Order of
 * lanes and of newErrors within a lane is irrelevant.
 */
export function gateFingerprint(results: ReadonlyArray<GateResultLike>): string {
  const rows = results
    .map((r) => `${r.lane}|${r.outcome}|${[...r.newErrors].slice().sort().join(",")}`)
    .sort();
  return fnv1aHex(rows.join("\n"));
}
