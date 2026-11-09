/**
 * scratch-blocks.ts — pure parsing for the Scratch panel (Right Panel v2, P2).
 * The agent's scratchpad renders as `head: body` sections; this parser splits
 * it into headed blocks and diffs consecutive renders so the UI can pulse the
 * block that was most recently updated (reference `.sb.live` behavior).
 */

export interface ScratchBlock {
  head: string;
  body: string;
}

const KNOWN_HEADS = new Set(["plan", "hypotheses", "findings", "next", "next steps", "progress", "notes", "decisions"]);

/**
 * Heading line: `head: rest` where the head is a short lowercase label
 * (known sections, or any ≤4-word label). Prose that merely contains a
 * colon ("Error: ..." with a longer sentence head) is not a heading.
 */
function matchHeading(line: string): { head: string; rest: string } | null {
  // Emitted sections are lowercase ("plan:", "findings:"); requiring a
  // lowercase head keeps prose like "Error: ..." from matching.
  const m = line.match(/^([a-z][a-z ]{0,40}):\s?(.*)$/);
  if (!m) return null;
  const head = m[1].trim();
  const rest = m[2] ?? "";
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length > 4) return null;
  if (!KNOWN_HEADS.has(head) && words.length > 2) return null;
  return { head, rest };
}

/**
 * Parse scratchpad text into blocks. Wrapped in `<scratchpad>…</scratchpad>`
 * is tolerated; stray pre-heading lines are ignored.
 */
export function parseScratchBlocks(text: string): ScratchBlock[] {
  if (!text) return [];
  const lines = text
    .replace(/^<scratchpad>\n?/i, "")
    .replace(/\n?<\/scratchpad>$/i, "")
    .split("\n");
  const blocks: ScratchBlock[] = [];
  let cur: ScratchBlock | null = null;
  for (const line of lines) {
    const h = matchHeading(line);
    if (h) {
      if (cur) blocks.push(cur);
      cur = { head: h.head, body: h.rest };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) blocks.push(cur);
  // Drop empty-headed strays but keep headed blocks even with empty bodies.
  return blocks.filter((b) => b.head.trim());
}

/**
 * Heads whose body changed vs the previous render (newly appeared heads count;
 * a first render pulses only the last block — the most recently written one).
 */
export function changedHeads(prev: ScratchBlock[], next: ScratchBlock[]): Set<string> {
  const out = new Set<string>();
  if (prev.length === 0) {
    if (next.length > 0) out.add(next[next.length - 1].head);
    return out;
  }
  const prevByHead = new Map(prev.map((b) => [b.head, b.body]));
  for (const b of next) {
    if (prevByHead.get(b.head) !== b.body) out.add(b.head);
  }
  return out;
}
