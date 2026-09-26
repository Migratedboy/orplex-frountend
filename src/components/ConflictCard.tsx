"use client";

// ConflictCard — the human curation surface for CRDT-merged overlapping
// edits. The merge engine (lib/merge/crdt.ts) converges automatically, but
// when both peers edited the SAME lines the result deserves a human glance.
// This card renders the conflicted region with both versions side by side
// and lets the reviewer pick per-hunk: keep both, theirs, or mine.

import { useState } from "react";

export interface ConflictHunk {
  id: string;
  file: string;
  lineHint: number;
  base: string; // shared ancestor line(s), "" = pure insertion
  ours: string;
  theirs: string;
}

export type HunkResolution = "both" | "ours" | "theirs";

export function resolveHunk(hunk: ConflictHunk, choice: HunkResolution): string[] {
  const lines = [];
  if (choice === "both" || choice === "ours") {
    if (hunk.ours.length > 0) lines.push(hunk.ours);
  }
  if (choice === "both" || choice === "theirs") {
    if (hunk.theirs.length > 0) lines.push(hunk.theirs);
  }
  return lines;
}

export function applyResolutions(text: string, hunks: ConflictHunk[], choices: Record<string, HunkResolution>): string {
  let out = text;
  for (const hunk of hunks) {
    const choice = choices[hunk.id] || "both";
    const replacement = resolveHunk(hunk, choice).join("\n");
    const marker = `<<<<<<< ${hunk.id}`;
    const start = out.indexOf(marker);
    if (start === -1) continue;
    const endMarker = ">>>>>>>";
    const end = out.indexOf(endMarker, start);
    if (end === -1) continue;
    out = out.slice(0, start) + replacement + out.slice(end + endMarker.length);
  }
  return out;
}

export function ConflictCard({
  hunk,
  onResolve,
  initial,
}: {
  hunk: ConflictHunk;
  onResolve?: (id: string, choice: HunkResolution) => void;
  initial?: HunkResolution;
}) {
  const [choice, setChoice] = useState<HunkResolution>(initial || "both");

  const pick = (next: HunkResolution) => {
    setChoice(next);
    onResolve?.(hunk.id, next);
  };

  const same = hunk.ours === hunk.theirs;

  return (
    <div className={`conflict-card${same ? " resolved" : ""}`}>
      <div className="conflict-card-head">
        <span className="conflict-card-file">{hunk.file}</span>
        <span className="conflict-card-line">line {hunk.lineHint}</span>
        {same && <span className="conflict-card-auto">identical — auto-resolved</span>}
      </div>
      <div className="conflict-card-versions">
        <div className={`conflict-version${choice === "ours" || choice === "both" ? " chosen" : ""}`}>
          <span className="conflict-version-label">This machine</span>
          <pre className="conflict-version-text">{hunk.ours || "(nothing)"}</pre>
        </div>
        <div className={`conflict-version${choice === "theirs" || choice === "both" ? " chosen" : ""}`}>
          <span className="conflict-version-label">Other machine</span>
          <pre className="conflict-version-text">{hunk.theirs || "(nothing)"}</pre>
        </div>
      </div>
      <div className="conflict-card-actions">
        <button
          type="button"
          className={`conflict-btn${choice === "both" ? " active" : ""}`}
          onClick={() => pick("both")}
          disabled={same}
          title="Keep both edits"
        >
          Keep both
        </button>
        <button
          type="button"
          className={`conflict-btn${choice === "ours" ? " active" : ""}`}
          onClick={() => pick("ours")}
          disabled={same}
          title="Keep this machine's version"
        >
          Mine
        </button>
        <button
          type="button"
          className={`conflict-btn${choice === "theirs" ? " active" : ""}`}
          onClick={() => pick("theirs")}
          disabled={same}
          title="Keep the other machine's version"
        >
          Theirs
        </button>
      </div>
    </div>
  );
}

export default ConflictCard;
