"use client";

import { useState } from "react";
import DiffView from "./DiffView";
import { apiFetch } from "@/lib/api-base";

// BranchReviewPanel — the per-artifact review gate for server-executed runs.
// When a run finishes on its own git branch, this is where the human decides:
// read the patch, resolve the paused approvals, then merge into the workspace
// or discard. Everything here talks to ownership-checked APIs; nothing assumes
// the executing process still exists.

export interface ReviewApproval {
  id: string;
  action: string;
  payload: unknown;
  status: string;
  createdAt: string;
}

export interface ReviewRun {
  id: string;
  status: string;
  result?: { branch?: string | null; worktreeDir?: string | null; summary?: string | null } | null;
  artifacts: Array<{ id: string; kind: string; content: string }>;
  approvals: ReviewApproval[];
}

function approvalSummary(a: ReviewApproval): string {
  const p = (a.payload || {}) as Record<string, unknown>;
  const cmd = typeof p.command === "string" ? p.command : typeof p.cmd === "string" ? p.cmd : "";
  if (cmd) return cmd.slice(0, 300);
  try {
    return JSON.stringify(a.payload).slice(0, 300);
  } catch {
    return a.action;
  }
}

export default function BranchReviewPanel({
  run,
  onChanged,
}: {
  run: ReviewRun;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"merge" | "discard" | null>(null);

  const branch = run.result?.branch || null;
  const patch = run.artifacts.find((a) => a.kind === "patch")?.content || "";
  const pending = run.approvals.filter((a) => a.status === "pending");

  const post = async (url: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || `Request failed (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const decide = async (requestId: string, action: "approve" | "reject") => {
    if (await post(`/api/agent/runs/${run.id}/approve`, { requestId, action })) onChanged();
  };

  const doMergeOrDiscard = async (action: "merge" | "discard") => {
    const ok = await post(`/api/agent/runs/${run.id}/merge`, { action });
    setConfirmAction(null);
    if (ok) onChanged();
  };

  // Flight recorder: download the self-verifying audit bundle (run row,
  // hash-chained events, artifacts, approvals, manifest.md).
  const exportBundle = async () => {
    try {
      const res = await apiFetch(`/api/agent/runs/${run.id}/export`);
      if (!res.ok) return;
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data.bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `orplex-audit-${run.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  return (
    <div className="branch-review border-t border-b border-surface-variant px-4 py-3 flex flex-col gap-3 bg-surface-variant/30">
      {/* Paused approvals — the executor is waiting on these */}
      {pending.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-label uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <span className="ms ms-sm">pause_circle</span> Waiting for your approval ({pending.length})
          </div>
          {pending.map((a) => (
            <div key={a.id} className="flex items-start gap-2 text-[11px] font-mono">
              <span className="text-on-surface-variant shrink-0">{a.action}:</span>
              <span className="flex-1 break-all">{approvalSummary(a)}</span>
              <button
                disabled={busy}
                onClick={() => decide(a.id, "approve")}
                className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-label disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={busy}
                onClick={() => decide(a.id, "reject")}
                className="px-2 py-0.5 rounded bg-red-600/90 text-white text-[10px] font-label disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Flight recorder export */}
      <div className="flex justify-end">
        <button
          onClick={exportBundle}
          className="px-2 py-0.5 rounded border border-surface-variant text-[10px] font-label text-on-surface-variant hover:bg-surface-variant/50"
          title="Download the tamper-evident audit bundle (run record, hash-chained events, artifacts, approvals)"
        >
          ⬇ Export audit bundle
        </button>
      </div>

      {/* Branch review */}
      {branch ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-label uppercase tracking-wide text-purple-600 dark:text-purple-400">
              ⑂ {branch}
            </span>
            {run.status === "completed" && (
              <>
                {confirmAction === null ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => setConfirmAction("merge")}
                      className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-label disabled:opacity-50"
                    >
                      Merge to workspace
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setConfirmAction("discard")}
                      className="px-2 py-0.5 rounded border border-red-400 text-red-500 text-[10px] font-label disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </>
                ) : (
                  <span className="flex items-center gap-2 text-[10px] font-label">
                    {confirmAction === "merge"
                      ? "Merge this branch into your working tree?"
                      : "Delete the branch and all agent changes?"}
                    <button
                      disabled={busy}
                      onClick={() => doMergeOrDiscard(confirmAction)}
                      className={`px-2 py-0.5 rounded text-white ${confirmAction === "merge" ? "bg-emerald-600" : "bg-red-600"}`}
                    >
                      Yes, {confirmAction}
                    </button>
                    <button onClick={() => setConfirmAction(null)} className="text-on-surface-variant underline">
                      cancel
                    </button>
                  </span>
                )}
              </>
            )}
          </div>

          {patch ? (
            <div className="max-h-72 overflow-y-auto rounded border border-surface-variant bg-surface">
              <DiffView diff={patch} readOnly maxHeight={280} />
            </div>
          ) : (
            <div className="text-[11px] font-mono text-on-surface-variant">
              No patch preview stored for this run. Review it in your repo:{" "}
              <code className="text-[10px]">git diff main...{branch}</code>
            </div>
          )}
        </div>
      ) : (
        run.status !== "pending" &&
        run.status !== "executing" &&
        pending.length === 0 && (
          <div className="text-[11px] font-mono text-on-surface-variant">
            This run made no branch — nothing to review.
          </div>
        )
      )}

      {error && <div className="text-[11px] font-mono text-red-500">{error}</div>}
    </div>
  );
}
