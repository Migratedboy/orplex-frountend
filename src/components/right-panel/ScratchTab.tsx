"use client";

/**
 * ScratchTab.tsx — the Scratch tab of the right panel: the agent's private
 * working memory, live. Right Panel v2 (P2):
 * - Reference presentation: headed blocks with uppercase orange headings,
 *   bullets, and a pulsing dot on the block most recently updated.
 * - Parser generalizes beyond plan/hypotheses/findings/next (any lowercase
 *   `head:` section — see src/lib/scratch-blocks.ts).
 * - Never persisted (D4): the task store is the only source; the empty copy
 *   shows when no task is running.
 */
import { useEffect, useRef, useState } from "react";
import { useScratchpad } from "@/hooks/useScratchpad";
import { parseScratchBlocks, changedHeads, type ScratchBlock } from "@/lib/scratch-blocks";

export function ScratchTab() {
  const { text } = useScratchpad();
  const blocks = parseScratchBlocks(text);

  const prevRef = useRef<ScratchBlock[]>([]);
  const [liveHeads, setLiveHeads] = useState<Set<string>>(new Set());

  // Pulse the block(s) that changed with this update; all others settle.
  useEffect(() => {
    setLiveHeads(changedHeads(prevRef.current, blocks));
    prevRef.current = blocks;
    // blocks is re-derived from `text` every render; keying on text keeps the
    // diff pinned to actual updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (blocks.length === 0) {
    return (
      <div className="rp-v2-scratch">
        <div className="rp-v2-sc-empty">No scratchpad yet — it appears here while the agent works a task.</div>
      </div>
    );
  }

  return (
    <div className="rp-v2-scratch rp-v2-scroll">
      {blocks.map((b, i) => (
        <div key={`${b.head}-${i}`} className={`rp-v2-sb ${liveHeads.has(b.head) ? "live" : ""}`}>
          <h4>{b.head}</h4>
          <ul>
            {(b.body || "—")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((line, j) => <li key={j}>{line}</li>)}
            {!b.body.trim() && <li className="rp-v2-sb-empty">—</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}
