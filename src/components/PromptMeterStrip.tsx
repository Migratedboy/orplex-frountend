"use client";

/**
 * PromptMeterStrip — designed rendering of the per-task prompt-meter summary
 * that the worker appends to the transcript ("Prompt meter: …"). Parsed by
 * parseMeterLine (prompt-meter.ts); anything unparseable falls back to a
 * plain italic paragraph so old saved messages never break.
 */

import { parseMeterLine } from "@/lib/prompt-meter";

function GaugeIcon() {
  return (
    <svg className="prompt-meter-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* semicircle gauge */}
      <path d="M4 14a8 8 0 0 1 16 0" />
      <path d="M12 14 15.5 9.5" />
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" />
      <path d="M2 20h20" />
    </svg>
  );
}

export default function PromptMeterStrip({ line }: { line: string }) {
  const data = parseMeterLine(line);

  if (!data) {
    // Fallback: not a (parseable) meter line — render as the plain text it is.
    return <p className="md-paragraph"><em>{line}</em></p>;
  }

  const fmt = (n: number) => n.toLocaleString();

  return (
    <div className="prompt-meter" role="status" aria-label={line.replace(/\*+/g, "")}>
      <span className="prompt-meter-head">
        <GaugeIcon />
        <span className="prompt-meter-label">Prompt meter</span>
      </span>

      <span className="prompt-meter-chip prompt-meter-chip-calls">
        {fmt(data.calls)} {data.calls === 1 ? "call" : "calls"}
      </span>

      {data.compactCalls > 0 ? (
        <>
          <span className="prompt-meter-chip prompt-meter-chip-full">{fmt(data.fullCalls)} full</span>
          <span className="prompt-meter-chip prompt-meter-chip-compact">{fmt(data.compactCalls)} compact</span>
        </>
      ) : (
        <span className="prompt-meter-chip prompt-meter-chip-full">all full-profile</span>
      )}

      <span className="prompt-meter-spacer" />

      {data.savedTokens != null && data.savedTokens > 0 && (
        <span className="prompt-meter-chip prompt-meter-chip-saved">
          ↓ {fmt(data.savedTokens)} saved{data.savedPct != null ? ` (${data.savedPct}%)` : ""}
        </span>
      )}

      <span className="prompt-meter-chip prompt-meter-chip-tokens">
        {fmt(data.actualTokens)} tokens
      </span>

      {data.counterfactualTokens != null && (
        <span className="prompt-meter-counterfactual" title="Cost if every call had used the full profile">
          vs {fmt(data.counterfactualTokens)} full-everywhere
        </span>
      )}
    </div>
  );
}
