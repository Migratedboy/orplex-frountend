"use client";

// SessionInsightsPopup — a collapsible floating panel showing what the agent
// produced and what it leaned on.
//
// Deliberately NOT a RightPanel tab: the right panel is a workspace surface
// (changes/files/terminal) that the user pins open, whereas this is a
// glanceable "what happened" summary they open and dismiss. Making it a tab
// would mean it competes with Preview/Terminal for the same space.
//
// It is also deliberately NOT a toast/notification: those are transient and
// assert nothing. This is a durable, re-openable read of real recorded data.
//
// Data comes from /api/agent/insights (see agent-insights.ts). Fetching is
// LAZY — only on first open — so landing on the chat never pays for a query
// most sessions never look at.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { IconInsights, IconClose, IconChevronDown, IconChevronRight, IconFile, IconTerminal, IconBrain } from "./Icons";

interface ToolUsage {
  tool: string;
  calls: number;
}
interface OutputRow {
  id: string;
  kind: string;
  name: string;
  createdAt: string;
}
interface PatternRow {
  name: string;
  description: string;
  steps: string[];
  successRate: number;
  useCount: number;
}
interface Summary {
  tasks: { total: number; completed: number; failed: number; running: number };
  toolCalls: number;
  toolUsage: ToolUsage[];
  outputs: OutputRow[];
  trajectories: { total: number; success: number; partial: number; failure: number };
  patterns: number;
  semantic: { total: number; vectorised: number };
}

/** Human label for a tool id: read_file -> "Read file", web_search -> "Web search". */
function humanize(tool: string): string {
  const stripped = tool.replace(/^browser_/, "");
  const spaced = stripped.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number | string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sip-section">
      <button
        className="sip-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Collapse" : "Expand"}
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <span className="sip-section-title">{title}</span>
        {count !== undefined && <span className="sip-count">{count}</span>}
      </button>
      {open && <div className="sip-section-body">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="sip-empty">{children}</p>;
}

export default function SessionInsightsPopup() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const loadedRef = useRef(false);
  const popRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        apiFetch("/api/agent/insights?summary=1"),
        apiFetch("/api/agent/insights?patterns=1"),
      ]);
      if (!s.ok) throw new Error(`HTTP ${s.status}`);
      const sj = (await s.json()) as { success?: boolean; summary?: Summary; error?: string };
      if (!sj.success || !sj.summary) throw new Error(sj.error || "Could not load insights.");
      setSummary(sj.summary);
      if (p.ok) {
        const pj = (await p.json()) as { patterns?: PatternRow[] };
        setPatterns(pj.patterns ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load insights.");
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      // Lazy first fetch: opening the panel is the signal that someone cares.
      if (next && !loadedRef.current) {
        loadedRef.current = true;
        void load();
      }
      return next;
    });
  }, [load]);

  // Outside-click dismiss, but only while UNPINNED. A pinned panel is an
  // explicit "keep this open" and must survive incidental clicks.
  useEffect(() => {
    if (!open || pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-sip-root]")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, pinned]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div data-sip-root className="sip-root">
      <button
        className={`sip-toggle${open ? " sip-toggle-open" : ""}`}
        onClick={toggle}
        title={open ? "Hide session insights" : "Show session insights"}
        aria-label={open ? "Hide session insights" : "Show session insights"}
        aria-expanded={open}
      >
        <IconInsights size={16} />
      </button>

      {open && (
        <div className="sip-popup" ref={popRef} role="dialog" aria-label="Session insights">
          <div className="sip-head">
            <span className="sip-title">Progress</span>
            <span className="sip-head-actions">
              <button
                className={`sip-pin${pinned ? " sip-pin-on" : ""}`}
                onClick={() => setPinned((p) => !p)}
                title={pinned ? "Unpin (click outside to close)" : "Pin open"}
                aria-pressed={pinned}
              >
                {pinned ? "Pinned" : "Pin"}
              </button>
              <button className="sip-close" onClick={() => setOpen(false)} title="Close" aria-label="Close">
                <IconClose size={14} />
              </button>
            </span>
          </div>

          {loading && <Empty>Loading…</Empty>}
          {!loading && error && <Empty>{error}</Empty>}

          {!loading && !error && summary && (
            <>
              <Section title="Outputs" count={summary.outputs.length || undefined}>
                {summary.outputs.length === 0 ? (
                  <Empty>Nothing produced yet.</Empty>
                ) : (
                  summary.outputs.map((o) => (
                    <div key={o.id} className="sip-row">
                      <IconFile size={13} />
                      <span className="sip-row-main">{o.name}</span>
                      <span className="sip-row-meta">{o.kind}</span>
                    </div>
                  ))
                )}
              </Section>

              <Section title="Used in this session" count={summary.toolUsage.length || undefined}>
                {summary.toolUsage.length === 0 ? (
                  <Empty>No tools used yet.</Empty>
                ) : (
                  <>
                    {summary.toolUsage.map((t) => (
                      <div key={t.tool} className="sip-row">
                        <IconTerminal size={13} />
                        <span className="sip-row-main">{humanize(t.tool)}</span>
                        <span className="sip-row-meta">×{t.calls}</span>
                      </div>
                    ))}
                    <p className="sip-foot">
                      {summary.toolCalls} tool calls · {summary.tasks.completed}/{summary.tasks.total} tasks completed
                    </p>
                  </>
                )}
              </Section>

              {patterns.length > 0 && (
                <Section title="Learned patterns" count={patterns.length} defaultOpen={false}>
                  {patterns.map((p) => (
                    <div key={p.name} className="sip-row sip-row-block">
                      <IconBrain size={13} />
                      <span className="sip-row-main">{p.steps.join(" → ")}</span>
                      <span className="sip-row-meta">
                        {Math.round(p.successRate * 100)}% · {p.useCount} runs
                      </span>
                    </div>
                  ))}
                </Section>
              )}

              {summary.trajectories.total > 0 && (
                <Section title="Run outcomes" count={summary.trajectories.total} defaultOpen={false}>
                  <div className="sip-row">
                    <span className="sip-row-main">Success</span>
                    <span className="sip-row-meta">{summary.trajectories.success}</span>
                  </div>
                  <div className="sip-row">
                    <span className="sip-row-main">Partial</span>
                    <span className="sip-row-meta">{summary.trajectories.partial}</span>
                  </div>
                  <div className="sip-row">
                    <span className="sip-row-main">Failed</span>
                    <span className="sip-row-meta">{summary.trajectories.failure}</span>
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}