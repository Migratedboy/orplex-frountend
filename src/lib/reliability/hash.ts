/**
 * reliability/hash.ts — content hashing for stale-read detection (Phase 3).
 *
 * A structured edit op can carry `expectedHash`: the hash of the file the
 * model LAST READ. Before applying, the file is re-read and hashed; a
 * mismatch means the file changed under the model (a concurrent lane, an
 * undo, a manual user edit) and the edit must not be applied blind.
 *
 * The algorithm is copied EXACTLY from compaction.ts `hashContent` — the same
 * offset basis (0x811c9dc5), the same 32-bit prime (0x01000193) applied with
 * Math.imul, and the same final fold of the string length into the hash. The
 * length fold is not vanilla FNV-1a, but compaction's incremental state
 * already depends on it, so two modules computing "the hash of the same text"
 * MUST agree — divergence here would let a future refactor claim two hashes
 * are comparable when they are not.
 */

/**
 * 32-bit FNV-1a over `content`, returned as an 8-char lowercase hex string.
 * Byte-for-byte the same algorithm as compaction.ts `hashContent` (length
 * folded in at the end).
 */
export function fnv1a(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h ^ content.length) >>> 0).toString(16).padStart(8, "0");
}

/**
 * The content hash used by EditOp preconditions. An alias of `fnv1a` so a
 * future algorithm change (e.g. a stronger hash for adversarial use) is a
 * one-line swap here rather than a hunt through every call site.
 */
export function contentHash(content: string): string {
  return fnv1a(content);
}
