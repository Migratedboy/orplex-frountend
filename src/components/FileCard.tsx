"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import type { FileCardPayload } from "@/lib/message-content";

type CardState = "live" | "expired" | "removed";

interface FileCardProps {
  file: FileCardPayload;
  /** Preview override — demo states seed these instead of a fetch. */
  demoState?: CardState;
}

/**
 * The create_file card: a staged in-memory deliverable the agent made for the
 * user. Chases its own state — three honest renders:
 *   live      → filename, size/lines, countdown-ish expires line, Download
 *               (+ Open as preview for single-file.html-ish text)
 *   expired   → inert "Expired" card (TTL elapsed while the chat sat open)
 *   removed   → inert "Removed" card (evicted by the 2-file cap, or the app
 *               restarted since — the store wipes by design)
 * Content itself is fetched only when the user clicks Download.
 */
export default function FileCard({ file, demoState }: FileCardProps) {
  const [state, setState] = useState<CardState>(demoState ?? "live");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // State chase: on mount (and on state changes from previews) re-check the
  // store unless this is a seeded demo render. A card can also flip live →
  // expired while the chat sits open; a one-shot check after mount handles
  // the common case without a polling loop.
  useEffect(() => {
    if (demoState) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/files/${file.id}/status`);
        if (cancelled || !res.ok) return;
        const j = (await res.json()) as { state?: string };
        if (j?.state === "live" || j?.state === "expired" || j?.state === "removed") {
          if (mounted.current) setState(j.state);
        }
      } catch {
        // unreachable store (cloud-hosted chat, offline): keep "live" render —
        // the Download click shows its own honest failure.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoState]);

  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/files/${file.id}?download=1`);
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { state?: string } | null;
        setState(res.status === 410 && j?.state === "expired" ? "expired" : "removed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // Network death mid-download: revert to a live card; a retry is the
      // only honest recovery.
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, file.filename, file.id]);

  if (state !== "live") {
    return (
      <div
        className="file-card file-card--gone"
        data-state={state}
        role="status"
        aria-live="polite"
      >
        <span className="file-card-icon"><span className="ms">{state === "expired" ? "hourglass_bottom" : "delete_forever"}</span></span>
        <div className="file-card-body">
          <div className="file-card-name">{file.filename}</div>
          <div className="file-card-meta">
            {state === "expired"
              ? "Expired — agent-staged files live 4 hours"
              : "Removed — app restarted or the 2-file limit evicted it"}
          </div>
        </div>
      </div>
    );
  }

  const kb = Math.max(1, Math.round(file.bytes / 1024));
  const evictedNote = file.evicted
    ? `replaced ${file.evicted.filename} — oldest of 2`
    : null;

  return (
    <div className="file-card" data-state="live">
      <span className="file-card-icon"><span className="ms">description</span></span>
      <div className="file-card-body">
        <div className="file-card-name">{file.filename}</div>
        <div className="file-card-meta">
          {kb} KB · {file.lines} lines · staged in memory
          {evictedNote ? ` · ${evictedNote}` : ""}
        </div>
      </div>
      <button
        type="button"
        className="file-card-dl"
        onClick={download}
        disabled={busy}
        aria-label={`Download ${file.filename}`}
      >
        <span className="ms">download</span> {busy ? "…" : ""}
      </button>
    </div>
  );
}
