"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api-base";
import { diffFileLines, type DiffLine, type FileDiff } from "@/lib/changes-diff";
import { forgetChanges, getLocalPendingChanges } from "@/lib/file-history";
import "./ChangesBar.css";

type ChangeStatus = "pending" | "kept" | "undone";

interface ChangeFile {
  path: string;
  before: string | null;
  current: string | null;
  expected: string | null;
  encoding: "utf8" | "base64";
  binary: boolean;
  status: ChangeStatus;
  expanded: boolean;
}

interface PendingResponseFile {
  path: string;
  before: string | null;
  current: string | null;
  expected: string | null;
  encoding: "utf8" | "base64";
  binary: boolean;
}

interface ChangesBarProps {
  isRunning: boolean;
}

const ICONS = {
  chevron: <path d="M4 6l4 4 4-4" />,
  edit: <path d="m10.5 2.5 3 3L6 13l-3.5.5L3 10z" />,
  newFile: <><path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM9 1.5V5h3.5" /><path d="M8 8v4M6 10h4" /></>,
  deleted: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  undo: <><path d="M5 3 2.5 5.5 5 8" /><path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  review: <><path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM9 1.5V5h3.5" /><path d="M6 8.5h4M6 11h4" /></>,
} as const;

function Icon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function fileName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function fileDirectory(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash + 1);
}

function getDiff(file: ChangeFile): FileDiff {
  if (file.binary) return { added: 0, removed: 0, lines: [] };
  return diffFileLines(file.before, file.current);
}

function highlight(text: string) {
  const pattern = /(\/\/.*$)|('[^']*'|"[^"]*"|`[^`]*`)|\b(export|const|let|return|if|else|for|of|await|async|function|new|throw|class|type|interface|import|from)\b|\b(\d[\d_]*)\b|[&<>]/g;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const value = match[0];
    const className = match[1] ? "ocb-hc" : match[2] ? "ocb-hs" : match[3] ? "ocb-hk" : match[4] ? "ocb-hn" : "";
    parts.push(className ? <span className={className} key={index}>{value}</span> : value);
    last = index + value.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function DiffRows({ lines, path }: { lines: DiffLine[]; path: string }) {
  const [shown, setShown] = useState(600);
  const visible = lines.slice(0, shown);
  const remaining = lines.length - visible.length;
  return (
    <>
      {visible.map((line, index) => line.kind === "hunk" ? (
        <div className="ocb-ln ocb-ln-hunk" key={`${path}-h-${index}`}>{line.text}</div>
      ) : (
        <div className={`ocb-ln ocb-ln-${line.kind}`} key={`${path}-${index}`}>
          <i>{line.kind === "add" ? line.newLine : line.oldLine}</i>
          <span>{highlight(line.text)}</span>
        </div>
      ))}
      {remaining > 0 && (
        <button className="ocb-more" type="button" onClick={() => setShown((count) => count + 600)}>
          Show {remaining.toLocaleString()} more lines
        </button>
      )}
    </>
  );
}

function toPendingFile(file: PendingResponseFile, previous?: ChangeFile): ChangeFile {
  return {
    ...file,
    status: "pending",
    expanded: previous?.expanded ?? true,
  };
}

export default function ChangesBar({ isRunning }: ChangesBarProps) {
  const [files, setFiles] = useState<ChangeFile[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [resolved, setResolved] = useState<"kept" | "undone" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadChanges = useCallback(async () => {
    let remoteFiles: PendingResponseFile[] | null = null;
    try {
      const response = await apiFetch("/api/agent/history?view=pending");
      const body = await response.json().catch(() => ({})) as { files?: PendingResponseFile[]; error?: string };
      if (!response.ok) throw new Error(body.error || response.statusText || "history service unavailable");
      if (!Array.isArray(body.files)) throw new Error("invalid pending history response");
      remoteFiles = body.files;
      setError((current) => current.startsWith("Could not load workspace edits:") ? "" : current);
    } catch (reason) {
      remoteFiles = null;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(`Could not load workspace edits: ${message}`);
    }

    setFiles((previous) => {
      const resolvedFiles = previous.filter((file) => file.status !== "pending");
      const previousByPath = new Map(previous.map((file) => [file.path, file]));
      const localFiles = remoteFiles ? [] : getLocalPendingChanges();
      const pendingByPath = new Map(
        (remoteFiles ?? []).map((file) => [file.path, toPendingFile(file, previousByPath.get(file.path))])
      );
      for (const file of localFiles) {
        if (pendingByPath.has(file.path)) continue;
        pendingByPath.set(file.path, toPendingFile({
          path: file.path,
          before: file.previousContent,
          current: file.newContent,
          expected: file.newContent,
          encoding: "utf8",
          binary: false,
        }, previousByPath.get(file.path)));
      }
      const pendingFiles = [...pendingByPath.values()];
      const pendingPaths = new Set(pendingFiles.map((file) => file.path));
      return [...pendingFiles, ...resolvedFiles.filter((file) => !pendingPaths.has(file.path))];
    });
  }, []);

  useEffect(() => {
    void loadChanges();
    const onHistory = () => { void loadChanges(); };
    window.addEventListener("orplex:file-history-updated", onHistory);
    return () => window.removeEventListener("orplex:file-history-updated", onHistory);
  }, [loadChanges]);

  useEffect(() => {
    void loadChanges();
  }, [isRunning, loadChanges]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => { void loadChanges(); }, 1200);
    return () => window.clearInterval(timer);
  }, [isRunning, loadChanges]);

  useEffect(() => {
    if (!reviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reviewOpen]);

  const pending = useMemo(() => files.filter((file) => file.status === "pending"), [files]);
  const summaries = useMemo(() => new Map(files.map((file) => [file.path, getDiff(file)])), [files]);
  const added = pending.reduce((total, file) => total + (summaries.get(file.path)?.added ?? 0), 0);
  const removed = pending.reduce((total, file) => total + (summaries.get(file.path)?.removed ?? 0), 0);
  const runningFile = pending[pending.length - 1];
  const disabled = isRunning || busy;

  useEffect(() => {
    if (pending.length === 0 && !isRunning) setReviewOpen(false);
  }, [pending.length, isRunning]);

  const setFileStatus = useCallback((paths: string[], status: ChangeStatus) => {
    const selected = new Set(paths);
    setFiles((previous) => previous.map((file) =>
      selected.has(file.path) ? { ...file, status, expanded: false } : file
    ));
    setResolved(status === "kept" ? "kept" : "undone");
  }, []);

  const keepFiles = useCallback(async (paths: string[]) => {
    if (disabled || paths.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/agent/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "keep", paths }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not keep these changes.");
      forgetChanges(paths);
      setFileStatus(paths, "kept");
      await loadChanges();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [disabled, loadChanges, setFileStatus]);

  const undoFiles = useCallback(async (paths: string[]) => {
    if (disabled || paths.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const restore = async (confirmChanges: boolean) => apiFetch("/api/agent/history", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo-pending", paths, confirmChanges }),
      });
      let response = await restore(false);
      let body = await response.json().catch(() => ({})) as { error?: string; changedPaths?: string[] };
      if (response.status === 409 && body.changedPaths?.length) {
        const names = body.changedPaths.map(fileName).join(", ");
        const confirmed = window.confirm(
          `${body.error || "These files changed on disk after the agent's last write."}\n\nOverwrite the newer content in: ${names}?`
        );
        if (!confirmed) return;
        response = await restore(true);
        body = await response.json().catch(() => ({})) as { error?: string };
      }
      if (!response.ok) throw new Error(body.error || "Could not undo these changes.");
      forgetChanges(paths);
      setFileStatus(paths, "undone");
      window.dispatchEvent(new CustomEvent("orplex:workspace-files-changed", { detail: paths }));
      await loadChanges();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [disabled, loadChanges, setFileStatus]);

  const toggleFile = (path: string) => {
    setFiles((previous) => previous.map((file) =>
      file.path === path ? { ...file, expanded: !file.expanded } : file
    ));
  };

  const dismiss = () => {
    setFiles([]);
    setResolved(null);
    setError("");
    setReviewOpen(false);
  };

  if (pending.length === 0 && !resolved) return null;

  const getFileIcon = (file: ChangeFile): keyof typeof ICONS =>
    file.before === null ? "newFile" : file.current === null ? "deleted" : "edit";

  const getFileTag = (file: ChangeFile) =>
    file.before === null ? "new" : file.current === null ? "deleted" : "";

  const actionButtons = (file: ChangeFile) => file.status === "pending" ? (
    <>
      <span className="ocb-counts">
        <span className="ocb-add">+{summaries.get(file.path)?.added ?? 0}</span>
        <span className="ocb-del">−{summaries.get(file.path)?.removed ?? 0}</span>
      </span>
      <span className="ocb-file-actions">
        <button type="button" className="ocb-icon-btn ocb-keep-icon" disabled={disabled} aria-label={`Keep ${file.path}`} onClick={() => void keepFiles([file.path])}>
          <Icon name="check" />
        </button>
        <button type="button" className="ocb-icon-btn ocb-undo-icon" disabled={disabled} aria-label={`Undo ${file.path}`} onClick={() => void undoFiles([file.path])}>
          <Icon name="undo" />
        </button>
      </span>
    </>
  ) : (
    <>
      <span className="ocb-counts">
        <span className="ocb-add">+{summaries.get(file.path)?.added ?? 0}</span>
        <span className="ocb-del">−{summaries.get(file.path)?.removed ?? 0}</span>
      </span>
      <span className="ocb-state">{file.status === "kept" ? "Kept" : "Undone"}</span>
    </>
  );

  const renderFileRow = (file: ChangeFile) => {
    const tag = getFileTag(file);
    return (
      <div className={`ocb-file ${tag === "new" ? "ocb-new" : tag === "deleted" ? "ocb-deleted" : ""} ${file.status !== "pending" ? `ocb-${file.status}` : ""}`} key={file.path}>
        <span className="ocb-file-icon"><Icon name={getFileIcon(file)} /></span>
        <span className="ocb-name">{fileName(file.path)}</span>
        <span className="ocb-directory">{fileDirectory(file.path)}</span>
        {tag && <span className="ocb-tag">{tag}</span>}
        <span className="ocb-spacer" />
        {actionButtons(file)}
      </div>
    );
  };

  return (
    <div className="orplex-changes" aria-live="polite">
      {reviewOpen && pending.length > 0 && (
        <section className={`ocb-review ${isRunning ? "ocb-running" : ""}`} role="dialog" aria-label="All edits">
          <header className="ocb-review-header">
            <b>All edits</b>
            <span className="ocb-counts">
              <span className="ocb-add">+{added}</span>
              <span className="ocb-del">−{removed}</span>
            </span>
            <span className="ocb-spacer" />
            <button type="button" className="ocb-button ocb-keep" disabled={disabled} onClick={() => void keepFiles(pending.map((file) => file.path))}>Keep all</button>
            <button type="button" className="ocb-button ocb-undo" disabled={disabled} onClick={() => void undoFiles(pending.map((file) => file.path))}>Undo all</button>
            <button type="button" className="ocb-icon-btn ocb-close" aria-label="Close all edits" onClick={() => setReviewOpen(false)}>
              <Icon name="close" />
            </button>
          </header>
          <div className="ocb-review-body">
            {files.map((file) => {
              const diff = summaries.get(file.path) ?? { added: 0, removed: 0, lines: [] };
              return (
                <section className={`ocb-review-file ${file.expanded ? "" : "ocb-collapsed"} ${file.status !== "pending" ? `ocb-${file.status}` : ""} ${file.before === null ? "ocb-new" : file.current === null ? "ocb-deleted" : ""}`} key={file.path}>
                  <div className="ocb-review-file-header">
                    <button type="button" className="ocb-review-toggle" aria-expanded={file.expanded} aria-label={`${file.expanded ? "Collapse" : "Expand"} diff for ${file.path}`} onClick={() => toggleFile(file.path)}>
                      <Icon name="chevron" className="ocb-chevron" />
                      <span className="ocb-file-icon"><Icon name={getFileIcon(file)} /></span>
                      <span className="ocb-name">{fileName(file.path)}</span>
                      <span className="ocb-directory">{fileDirectory(file.path)}</span>
                      {getFileTag(file) && <span className="ocb-tag">{getFileTag(file)}</span>}
                      <span className="ocb-spacer" />
                    </button>
                    {actionButtons(file)}
                  </div>
                  {file.expanded && (
                    <pre className="ocb-diff">
                      {file.binary
                        ? <div className="ocb-binary">Binary file changed</div>
                        : <DiffRows lines={diff.lines} path={file.path} />}
                    </pre>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      )}

      {pending.length === 0 ? (
        <div className={`ocb-done ${resolved === "undone" ? "ocb-done-undone" : ""}`}>
          <Icon name={resolved === "undone" ? "undo" : "check"} />
          <span>{resolved === "undone" ? "Changes undone" : "Changes kept"}</span>
          <span className="ocb-spacer" />
          <button type="button" className="ocb-button" onClick={dismiss}>Dismiss</button>
        </div>
      ) : (
        <div className={`ocb-bar ${expanded ? "ocb-open" : ""} ${isRunning ? "ocb-running" : ""}`}>
          <div className="ocb-bar-header">
            <button type="button" className="ocb-summary" aria-expanded={expanded} disabled={isRunning} onClick={() => setExpanded((open) => !open)}>
              {isRunning
                ? <><span className="ocb-spinner" /><b className="ocb-shimmer">Editing {runningFile ? fileName(runningFile.path) : "files"}</b></>
                : <><Icon name="chevron" className="ocb-chevron" /><b>{pending.length} file{pending.length === 1 ? "" : "s"} changed</b></>}
              <span className="ocb-counts">
                <span className="ocb-add">+{added}</span>
                <span className="ocb-del">−{removed}</span>
              </span>
            </button>
            <div className="ocb-actions">
              <button type="button" className="ocb-button ocb-keep" disabled={disabled} onClick={() => void keepFiles(pending.map((file) => file.path))}>Keep</button>
              <button type="button" className="ocb-button ocb-undo" disabled={disabled} onClick={() => void undoFiles(pending.map((file) => file.path))}>Undo</button>
              <button type="button" className="ocb-button ocb-review-button" title="View all edits" aria-label="View all edits" aria-expanded={reviewOpen} onClick={() => setReviewOpen((open) => !open)}>
                <Icon name="review" />
              </button>
            </div>
          </div>
          <div className="ocb-list-wrap">
            <div className="ocb-list-inner">
              <div className="ocb-files">{files.map(renderFileRow)}</div>
            </div>
          </div>
        </div>
      )}
      {error && <div className="ocb-error" role="alert">{error}</div>}
    </div>
  );
}
