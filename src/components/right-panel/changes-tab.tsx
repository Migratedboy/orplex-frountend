"use client";

/**
 * changes-tab.tsx — the Changes tab of the right panel. Right Panel v2 (P3):
 * - C1/C2: Uncommitted (working tree vs HEAD incl. untracked) / All (+ commits
 *   since the merge-base) from GET /api/agent/changes-git (LOCAL_ONLY git shape).
 * - C3: status icon (added/modified/deleted/renamed), dim dir + bright file,
 *   +N −M, totals in the header.
 * - C4: row expand → DiffView with hunk accept/reject preserved (window
 *   applyHunkDecisions shim, same as v1).
 * - C5: row hover actions — Undo (when a snapshot exists), Checkpoint
 *   (create), Restore… (list + PUT restore of the latest run's checkpoints).
 * - C6: live refresh on file-history events + window focus (debounced).
 * - C7: non-git folder → durable history fallback list (the v1 card view).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import DiffView from "../DiffView";
import { apiFetch } from "@/lib/api-base";
import { ChangesPanelSkeleton } from "../PanelSkeletons";
import { useFileSystemContext } from "../FileSystemProvider";
import { getPreviousContent, undoLastChange, subscribeFileHistory } from "@/lib/file-history";
import { IconFilePlus, IconEdit, IconTrash, IconFork, IconUndo } from "../Icons";
import type { GitChangeRow, GitChangeStatus } from "@/lib/git-changes";

const STATUS_ICON: Record<GitChangeStatus, { Icon: (p: { size?: number }) => React.ReactNode; cls: string }> = {
  added: { Icon: IconFilePlus, cls: "a" },
  modified: { Icon: IconEdit, cls: "m" },
  deleted: { Icon: IconTrash, cls: "x" },
  renamed: { Icon: IconFork, cls: "m" },
};

function splitPath(path: string): { dir: string; file: string } {
  const last = path.lastIndexOf("/");
  if (last === -1) return { dir: "", file: path };
  return { dir: path.slice(0, last + 1), file: path.slice(last + 1) };
}

export function ChangesTab() {
  const [scope, setScope] = useState<"unc" | "all">("unc");
  const [loading, setLoading] = useState(true);
  const [isGit, setIsGit] = useState<boolean | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [rows, setRows] = useState<GitChangeRow[]>([]);
  const [totals, setTotals] = useState<{ added: number; deleted: number }>({ added: 0, deleted: 0 });
  const [truncated, setTruncated] = useState(false);
  const [committedEmpty, setCommittedEmpty] = useState(false);
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffBusy, setDiffBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [cpFor, setCpFor] = useState<string | null>(null); // checkpoint row path
  const { writeFile } = useFileSystemContext();

  const load = useCallback(async (sc: "unc" | "all" = scope) => {
    try {
      const res = await apiFetch(`/api/agent/changes-git?scope=${sc}`);
      const data = (await res.json()) as {
        success?: boolean;
        isGitRepo?: boolean;
        branch?: string | null;
        rows?: GitChangeRow[];
        totals?: { added: number; deleted: number };
        truncated?: boolean;
        committedEmpty?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success) throw new Error(data.error || "Git changes failed");
      setIsGit(data.isGitRepo ?? true);
      setBranch(data.branch ?? null);
      setRows(data.rows ?? []);
      setTotals(data.totals ?? { added: 0, deleted: 0 });
      setTruncated(data.truncated ?? false);
      setCommittedEmpty(data.committedEmpty ?? false);
    } catch (e) {
      if (isGit === null) setIsGit(false);
      setNote((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope, isGit]);

  useEffect(() => { void load(); }, [load]);

  // Live refresh on agent write events + toast from writeFile (C6), debounced.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 800);
    };
    const off = subscribeFileHistory(schedule);
    const onFocus = () => void load();
    window.addEventListener("orplex:file-history-updated", schedule);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("orplex:file-history-updated", schedule);
      window.removeEventListener("focus", onFocus);
      if (t) clearTimeout(t);
    };
  }, [load]);

  const expandRow = async (path: string) => {
    if (expanded === path) { setExpanded(null); return; }
    setExpanded(path);
    if (diffs[path] !== undefined) return;
    setDiffBusy(true);
    try {
      const res = await apiFetch(`/api/agent/changes-git?path=${encodeURIComponent(path)}`);
      const data = (await res.json()) as { diff?: string };
      if (res.ok && typeof data.diff === "string") setDiffs((d) => ({ ...d, [path]: data.diff! }));
      else setDiffs((d) => ({ ...d, [path]: "_Diff unavailable._" }));
    } catch {
      setDiffs((d) => ({ ...d, [path]: "_Diff unavailable._" }));
    } finally {
      setDiffBusy(false);
    }
  };

  const doUndo = async (path: string) => {
    const prev = undoLastChange(path);
    if (prev === null) {
      setNote("No recorded snapshot for this file — undo is unavailable");
      return;
    }
    const ok = await writeFile(path, prev);
    setNote(ok ? `Undid last recorded change to ${splitPath(path).file}` : "Undo write failed");
    if (ok) void load();
  };

  // Checkpoint flow (C5): resolve the latest run once, then create/list/restore.
  const latestRunId = useCallback(async (): Promise<string | null> => {
    try {
      const res = await apiFetch("/api/agent/runs?limit=1");
      const data = (await res.json()) as { success?: boolean; runs?: Array<{ id?: string }> };
      return data.runs?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }, []);

  const doCheckpoint = async () => {
    setNote("Creating checkpoint…");
    const runId = await latestRunId();
    if (!runId) { setNote("No runs yet — checkpoints attach to a run"); return; }
    try {
      const res = await apiFetch("/api/agent/checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, label: "manual (changes tab)" }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; checkpoint?: { label?: string; kind?: string } };
      if (!res.ok || !data.success) throw new Error(data.error || "Checkpoint failed");
      setNote(`Checkpoint saved (${data.checkpoint?.kind ?? ""})`);
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const [cpList, setCpList] = useState<Array<{ sequence: number; label?: string; kind?: string }>>([]);
  const openRestore = async () => {
    const runId = await latestRunId();
    if (!runId) { setNote("No runs yet — nothing to restore"); return; }
    try {
      const res = await apiFetch(`/api/agent/checkpoints?runId=${encodeURIComponent(runId)}`);
      const data = (await res.json()) as { success?: boolean; checkpoints?: Array<{ sequence: number; label?: string; kind?: string }> };
      if (!res.ok || !data.success) throw new Error("Checkpoint list failed");
      setCpList(data.checkpoints ?? []);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const doRestore = async (sequence: number) => {
    const runId = await latestRunId();
    if (!runId) { setNote("No runs yet — nothing to restore"); return; }
    try {
      const res = await apiFetch("/api/agent/checkpoints", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, sequence }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || "Restore failed");
      setCpList([]);
      setCpFor(null);
      setNote(`Restored checkpoint ${sequence}`);
      void load();
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  if (loading && isGit === null) return <ChangesPanelSkeleton />;

  return (
    <div className="rp-v2-ch">
      <div className="rp-v2-ch-head">
        <button className={`rp-v2-pill ${scope === "all" ? "on" : ""}`} onClick={() => { setScope("all"); void load("all"); }}>All</button>
        <button className={`rp-v2-pill ${scope === "unc" ? "on" : ""}`} onClick={() => { setScope("unc"); void load("unc"); }}>Uncommitted</button>
        <div className="rp-v2-tot">
          <span className="a">+{totals.added}</span>
          <span className="d">−{totals.deleted}</span>
        </div>
        {branch && <span className="rp-v2-ch-branch" title="Current git branch">{branch}</span>}
      </div>

      {note && <div className="rp-v2-ch-note" aria-live="polite">{note}</div>}

      {isGit === false ? (
        <HistoryFallback />
      ) : rows.length === 0 ? (
        <div className="rp-v2-ch-empty">No file changes yet — changes appear here as the agent writes files</div>
      ) : (
        <div className="rp-v2-ch-list rp-v2-scroll">
          {committedEmpty && scope === "all" && (
            <div className="rp-v2-ch-note">No extra commits on this branch yet — showing uncommitted.</div>
          )}
          {truncated && <div className="rp-v2-ch-note">Showing first {rows.length} changed files.</div>}
          {rows.map((r) => {
            const { Icon, cls } = STATUS_ICON[r.status] ?? STATUS_ICON.modified;
            const { dir, file } = splitPath(r.path);
            const isOpen = expanded === r.path;
            const canUndo = getPreviousContent(r.path) !== null;
            return (
              <div key={r.path}>
                <div className="rp-v2-row" onClick={() => void expandRow(r.path)} title={r.path}>
                  <span className={`rp-v2-fi ${cls}`} aria-hidden="true"><Icon size={18} /></span>
                  <span className="rp-v2-p"><span className="rp-v2-dir">{dir}</span><span className="rp-v2-file">{file}</span></span>
                  <span className="rp-v2-n a">+{r.added}</span>
                  <span className={`rp-v2-n ${r.deleted ? "d" : "z"}`}>−{r.deleted}</span>
                  <span className="rp-v2-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="rp-v2-row-btn" title={canUndo ? "Undo last recorded change" : "No recorded snapshot"} disabled={!canUndo} onClick={() => void doUndo(r.path)}>
                      <IconUndo size={13} />
                    </button>
                    <button className="rp-v2-row-btn" title="Save a checkpoint now" onClick={() => void doCheckpoint()}>CP</button>
                    <button className="rp-v2-row-btn" title="Restore a checkpoint…" onClick={() => { setCpFor(cpFor === r.path ? null : r.path); if (cpFor !== r.path) void openRestore(); }}>↺</button>
                  </span>
                </div>
                {cpFor === r.path && (
                  <div className="rp-v2-cp">
                    {cpList.length === 0 ? (
                      <div className="rp-v2-cp-empty">No checkpoints on the latest run</div>
                    ) : (
                      cpList.map((cp) => (
                        <button key={cp.sequence} className="rp-v2-cp-item" onClick={() => void doRestore(cp.sequence)}>
                          #{cp.sequence} · {cp.label || "checkpoint"}{cp.kind ? ` (${cp.kind})` : ""}
                        </button>
                      ))
                    )}
                  </div>
                )}
                {isOpen && (
                  <div className="rp-v2-ch-diff-wrap">
                    {diffBusy && diffs[r.path] === undefined ? (
                      <div className="rp-v2-ch-empty">Loading diff…</div>
                    ) : (
                      <DiffView
                        diff={diffs[r.path] ?? ""}
                        readOnly={false}
                        maxHeight={320}
                        onApply={async (filteredDiff, accepted, rejected) => {
                          const apply = (window as unknown as { applyHunkDecisions?: (path: string, d: string, a: number[], r: number[]) => Promise<void> }).applyHunkDecisions;
                          await apply?.(r.path, filteredDiff, [...accepted], [...rejected]);
                          const fileName = splitPath(r.path).file;
                          setApplied(rejected.size > 0 ? `Rolled back ${fileName} — ${rejected.size} hunk(s) rejected` : `Applied ${accepted.size} hunk(s) to ${fileName}`);
                          setTimeout(() => setApplied(null), 4000);
                        }}
                        onHunkComment={(hunkId, comment) => {
                          (window as unknown as { submitHunkComment?: (path: string, id: number, c: string) => void }).submitHunkComment?.(r.path, hunkId, comment);
                        }}
                      />
                    )}
                    {applied && <div className="rp-v2-ch-applied">{applied}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- non-git fallback: the v1 durable-history card list (C7) --------------

interface ChangeItem {
  path: string;
  timestamp: number;
  isNew: boolean;
  diff: string;
  lineCount: number;
}

function HistoryFallback() {
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const [changesLoaded, setChangesLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await apiFetch("/api/agent/changes");
        const data = await res.json();
        if (alive && data.changes) setChanges(data.changes);
      } catch {}
      finally {
        if (alive) setChangesLoaded(true);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  if (!changesLoaded) return <ChangesPanelSkeleton />;
  if (changes.length === 0) {
    return (
      <div className="rp-v2-ch-empty">
        Not a git repository — agent changes still appear here from the local history.
      </div>
    );
  }

  return (
    <div className="rp-v2-ch-list rp-v2-scroll">
      {changes.map((c, i) => {
        const isExpanded = expanded === i;
        return (
          <div key={i} className="rp-v2-row" onClick={() => setExpanded(isExpanded ? null : i)}>
            <span className={`rp-v2-fi ${c.isNew ? "a" : "m"}`} aria-hidden="true">
              {c.isNew ? <IconFilePlus size={18} /> : <IconEdit size={18} />}
            </span>
            <span className="rp-v2-p"><span className="rp-v2-file">{c.path.split("/").pop()}</span></span>
            <span className="rp-v2-n z">{c.lineCount}L</span>
          </div>
        );
      })}
      {expanded !== null && changes[expanded] && (
        <div className="rp-v2-ch-diff-wrap">
          <DiffView
            diff={changes[expanded].diff}
            readOnly={false}
            maxHeight={320}
            onApply={async (filteredDiff, accepted, rejected) => {
              const apply = (window as unknown as { applyHunkDecisions?: (path: string, d: string, a: number[], r: number[]) => Promise<void> }).applyHunkDecisions;
              const c = changes[expanded];
              await apply?.(c.path, filteredDiff, [...accepted], [...rejected]);
              const fileName = c.path.split("/").pop();
              setAppliedNote(rejected.size > 0 ? `Rolled back ${fileName} — ${rejected.size} hunk(s) rejected` : `Applied ${accepted.size} hunk(s) to ${fileName}`);
              setTimeout(() => setAppliedNote(null), 4000);
            }}
            onHunkComment={(hunkId, comment) => {
              (window as unknown as { submitHunkComment?: (path: string, id: number, c: string) => void }).submitHunkComment?.(changes[expanded].path, hunkId, comment);
            }}
          />
          {appliedNote && <div className="rp-v2-ch-applied">{appliedNote}</div>}
        </div>
      )}
    </div>
  );
}

void 0;
