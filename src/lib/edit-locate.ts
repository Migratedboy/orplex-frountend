/**
 * edit-locate.ts — locate an edit's target region inside the CURRENT file
 * content, never against stale offsets.
 *
 * The model sends text that usually matches exactly. When it doesn't (the
 * dominant real-world case: the model sends \n while the file on disk is
 * CRLF after an earlier Windows write), a plain `includes()` fails and the
 * agent gives up on re-editing its own code. This module re-locates the
 * region with line-ending-insensitive matching and maps the found range back
 * to the original content's indexes.
 *
 * Rules:
 *  - Exact match first, at String.replace parity (first occurrence).
 *  - Fallback: normalize \r\n → \n in both, search again, map back.
 *  - Never guess: if the normalized target cannot be found, return null and
 *    the caller fails the edit with a clear error.
 */

export interface EditRange {
  /** Inclusive start index in the ORIGINAL content. */
  start: number;
  /** Exclusive end index in the ORIGINAL content. */
  end: number;
}

/** Index map from normalized string position → original string position. */
function crlfIndexMap(original: string): number[] {
  const map = new Array<number>(original.replace(/\r/g, "").length + 1);
  let norm = 0;
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === 13) continue; // \r is dropped by normalization
    map[norm++] = i;
  }
  map[norm] = original.length; // end-of-string position
  return map;
}

function searchFirst(haystack: string, needle: string): number {
  return haystack.indexOf(needle);
}

function searchLast(haystack: string, needle: string): number {
  return haystack.lastIndexOf(needle);
}

function searchCount(haystack: string, needle: string): number {
  if (needle.length === 0) return 0; // empty needle: indexOf("") never advances
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Map a match [offset, offset+len) in the normalized text back to original
 * indexes. The end is the position AFTER the match's last normalized char
 * (`map[offset + len - 1] + 1`): using `map[offset + len]` instead would
 * overshoot whenever the match ends right at a \r\n → \n collapse, because
 * the map skips dropped \r's and the next kept char sits past them — the \r
 * would then be eaten by the replacement, corrupting line endings.
 */
function mapBack(map: number[], offset: number, length: number): EditRange | null {
  if (length === 0 || offset < 0 || offset + length > map.length) return null;
  const start = map[offset];
  const end = map[offset + length - 1] + 1;
  return start === undefined || end === undefined ? null : { start, end };
}

function locate(
  content: string,
  target: string,
  find: (haystack: string, needle: string) => number
): EditRange | null {
  if (content.length === 0 || target.length === 0) return null;
  const exact = find(content, target);
  if (exact !== -1) return { start: exact, end: exact + target.length };

  const normalized = content.replace(/\r\n/g, "\n");
  const normalizedTarget = target.replace(/\r\n/g, "\n");
  if (normalized === content) return null; // no CRLF anywhere: exact miss IS a miss
  const offset = find(normalized, normalizedTarget);
  if (offset === -1) return null;
  return mapBack(crlfIndexMap(content), offset, normalizedTarget.length);
}

/** First match (exact first, then line-ending-insensitive). String.replace parity. */
export function locateFirstRange(content: string, target: string): EditRange | null {
  return locate(content, target, searchFirst);
}

/** Last match — for "replace the back-most occurrence" call sites. */
export function locateLastRange(content: string, target: string): EditRange | null {
  return locate(content, target, searchLast);
}

/**
 * Unique match required (the apply_edit_ops "exactly_one" contract):
 * exactly one occurrence in exact OR normalized form, and the two forms must
 * agree (a target that matches twice exactly is refused even if unique after
 * normalization).
 */
export function locateUniqueRange(content: string, target: string): EditRange | null {
  if (content.length === 0 || target.length === 0) return null;
  const exactCount = searchCount(content, target);
  if (exactCount > 1) return null;
  const exact = exactCount === 1 ? locate(content, target, searchFirst) : null;
  if (exactCount === 1) return exact;

  const normalized = content.replace(/\r\n/g, "\n");
  const normalizedTarget = target.replace(/\r\n/g, "\n");
  if (normalized === content || normalizedTarget.length === 0) return null;
  if (searchCount(normalized, normalizedTarget) !== 1) return null;
  const offset = searchFirst(normalized, normalizedTarget);
  return mapBack(crlfIndexMap(content), offset, normalizedTarget.length);
}
