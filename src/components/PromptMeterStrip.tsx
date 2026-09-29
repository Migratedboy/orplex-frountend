"use client";

/**
 * PromptMeterStrip — designed rendering of the per-task prompt-meter summary
 * that the worker appends to the transcript ("Prompt meter: …"). Parsed by
 * parseMeterLine (prompt-meter.ts); anything unparseable falls back to a
 * plain italic paragraph so old saved messages never break.
 */

import { parseMeterLine } from "@/lib/prompt-meter";

function GaugeIcon() {
  return <span className="ms prompt-meter-icon" style={{ fontSize: 13 }} aria-hidden="true">speed</span>;
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
          <span className="ms ms-sm">south</span> {fmt(data.savedTokens)} saved{data.savedPct != null ? ` (${data.savedPct}%)` : ""}
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
