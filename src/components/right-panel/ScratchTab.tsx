"use client";

/**
 * ScratchTab.tsx — the Scratch tab of the right panel: the agent's private
 * working memory, live. Moved verbatim from RightPanel.tsx (behavior
 * unchanged in P1; Freebuff re-skin + no-persist rule land in P2 — D4).
 */
import { useScratchpad } from "@/hooks/useScratchpad";

export function ScratchTab() {
  const { text, live } = useScratchpad();
  if (!text) {
    return (
      <div className="rp-empty">
        No scratchpad yet — it appears here while the agent works a task.
      </div>
    );
  }
  // Render plan/hypotheses/findings/next as headed blocks; fall back to raw.
  const lines = text.replace(/^<scratchpad>\n?/, "").replace(/\n?<\/scratchpad>$/, "").split("\n");
  const blocks: Array<{ head: string; body: string }> = [];
  let cur: { head: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^(plan|hypotheses|findings|next):\s?(.*)$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { head: m[1], body: m[2] };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) blocks.push(cur);
  return (
    <div className="rp-scratch">
      {!live && <div className="rp-scratch-stale">Last session — read-only snapshot</div>}
      {blocks.length > 0 ? (
        blocks.map((b, i) => (
          <div key={i} className="rp-scratch-block">
            <div className="rp-scratch-head">{b.head}</div>
            <div className="rp-scratch-body">{b.body || <span className="rp-scratch-empty">—</span>}</div>
          </div>
        ))
      ) : (
        <pre className="rp-scratch-raw">{text}</pre>
      )}
    </div>
  );
}
