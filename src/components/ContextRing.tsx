"use client";

/**
 * ContextRing — the context-window meter in the composer toolbar.
 *
 * Ported from the reference design (context-ring.html): same ring geometry,
 * same warn/crit thresholds (70% / 90%), same popover placement algorithm
 * (right → left → above/below, clamped to the window, with a hover bridge),
 * same ok/warn/crit + four segment colours — but rebuilt as React with the
 * app's own tokens and the app's REAL numbers.
 *
 * Numbers come from POST /api/agent/context-usage, which measures the request
 * with the same builders /api/chat uses. The buttons fire `ctx:compact` and
 * `ctx:new` on the root; the composer wires them to real actions.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getContextSnapshot, subscribeContextSnapshot } from "@/lib/context-snapshot";
import { apiFetch } from "@/lib/api-base";
import "./context-ring.css";

export type ContextSegmentKey = "system" | "tools" | "files" | "messages";

export interface UsageSegment {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
}

interface UsageResponse {
  success: boolean;
  usage?: {
    limit: number;
    limitEstimated: boolean;
    resolvedModel: string | null;
    source: "provider" | "estimate";
    segments: UsageSegment[];
    total: number;
    avgMessage: number;
  };
}

const SEGMENT_COLORS: Record<ContextSegmentKey, string> = {
  system: "var(--ctx-system)",
  tools: "var(--ctx-tools)",
  files: "var(--ctx-files)",
  messages: "var(--ctx-messages)",
};

const C = 2 * Math.PI * 10; // circumference of the reference's r=10 ring
const GAP = 0.5;
const REFRESH_DEBOUNCE_MS = 200;

interface ContextRingProps {
  /** Selected model id (PromptBar's `model.key`). */
  model?: string | null;
  mode: string;
  effort?: string;
  /** Draft text, so the ring answers "how full if I send this?". */
  draft: string;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const pctOf = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);

export default function ContextRing({ model, mode, effort, draft }: ContextRingProps) {
  const snapshot = useSyncExternalStore(subscribeContextSnapshot, getContextSnapshot, getContextSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [usage, setUsage] = useState<UsageResponse["usage"] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"compact" | null>(null);

  // Latest inputs in a ref so the debounced fetch always sends current values
  // without re-creating the timer on every keystroke.
  const inputs = useRef({ model, mode, effort, draft, snapshot });
  inputs.current = { model, mode, effort, draft, snapshot };

  const load = useCallback(async () => {
    const { model: m, mode: md, effort: ef, draft: d, snapshot: snap } = inputs.current;
    try {
      const res = await apiFetch("/api/agent/context-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: snap.conversationId,
          model: m ?? undefined,
          mode: md === "plan" || md === "ask" ? md : "code",
          effort: ef,
          messages: snap.messages.slice(-200),
          draft: d,
          attachments: snap.files,
          mentions: snap.mentions,
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as UsageResponse;
      if (data?.success && data.usage) setUsage(data.usage);
    } catch {
      // A ring that cannot reach the meter keeps its last honest reading.
    }
  }, []);

  // Debounced refresh: draft/attachments change per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load, draft, snapshot, model, mode, effort]);

  // Turn boundaries, chat switches, model changes, connector toggles and
  // compaction all move the real number, and none of them is a keystroke.
  useEffect(() => {
    const refresh = () => void load();
    const events = [
      "orplex:chat-sent",
      "orplex:new-chat",
      "orplex:open-conversation",
      "orplex:model-changed",
      "orplex:setting",
      "orplex:skills-changed",
      "orplex:workspace-files-changed",
      "orplex:context-compacted",
    ];
    for (const e of events) window.addEventListener(e, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      for (const e of events) window.removeEventListener(e, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const limit = usage?.limit && usage.limit > 0 ? usage.limit : 0;
  // Stable identity: the ring's dashArray memo must not re-run every render.
  const segments = useMemo(() => usage?.segments ?? [], [usage]);
  const total = limit > 0 ? Math.min(usage?.total ?? 0, limit) : usage?.total ?? 0;
  const free = Math.max(0, limit - total);
  const fraction = limit > 0 ? total / limit : 0;
  const state = fraction >= 0.9 ? "crit" : fraction >= 0.7 ? "warn" : "ok";
  const avgMessage = usage?.avgMessage ?? 1_500;
  const shown = Math.round(Math.min(1, fraction) * 100);

  /** Popover is placed from measured sizes: right of the ring, else left, else above/below. */
  const place = useCallback(() => {
    const pop = popRef.current;
    const card = cardRef.current;
    const anchor = btnRef.current;
    if (!pop || !card || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const m = 8;
    const g = 12; // gap between ring and popover
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

    const side: "right" | "left" | "above" | "below" =
      r.right + g + w <= vw - m ? "right"
      : r.left - g - w >= m ? "left"
      : r.top - g - h >= m || r.top > vh - r.bottom ? "above"
      : "below";
    const horiz = side === "right" || side === "left";

    let x: number;
    let y: number;
    if (horiz) {
      x = side === "right" ? r.right + g : r.left - g - w;
      y = r.top + r.height / 2 - h / 2;
    } else {
      x = r.left + r.width / 2 - w / 2;
      y = side === "above" ? r.top - g - h : r.bottom + g;
    }
    x = clamp(x, m, Math.max(m, vw - w - m));
    y = clamp(y, m, Math.max(m, vh - h - m));

    pop.dataset.side = side;
    // The popover carries the hover bridge as padding, so shift it by the gap.
    pop.style.left = `${x - (horiz ? g : 0)}px`;
    pop.style.top = `${y - (horiz ? 0 : g)}px`;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place, usage, draft]);

  // Recompute on open: the provider number may have moved since the last turn.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const rings = useMemo(() => {
    let start = 0;
    return segments.map((s) => {
      const len = limit > 0 ? (Math.min(s.tokens, limit) / limit) * C : 0;
      const el = {
        key: s.key,
        color: SEGMENT_COLORS[s.key],
        dashArray: `${Math.max(len - GAP, 0)} ${C}`,
        dashOffset: -start,
      };
      start += len;
      return el;
    });
  }, [segments, limit]);

  const messagesLeft = Math.floor(free / Math.max(1, avgMessage));
  const note =
    state === "crit"
      ? "Almost full. Compact or start a new chat now."
      : state === "warn"
        ? "Getting full. Older messages may be dropped soon."
        : "";

  const compact = async () => {
    setBusy("compact");
    try {
      rootRef.current?.dispatchEvent(new CustomEvent("ctx:compact", { bubbles: true }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ctx-wrap" ref={rootRef} data-state={state}>
      <button
        className="ctx-ring"
        ref={btnRef}
        type="button"
        aria-label={`Context window ${shown}% full`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle className="ctx-track" cx="12" cy="12" r="10" />
          {rings.map((r) => (
            <circle
              key={r.key}
              className="ctx-seg"
              data-key={r.key}
              cx="12"
              cy="12"
              r="10"
              style={{ stroke: r.color, strokeDasharray: r.dashArray, strokeDashoffset: r.dashOffset }}
            />
          ))}
        </svg>
        <span className="ctx-pct">
          {shown}
          <small>%</small>
        </span>
      </button>

      <div
        className="ctx-pop"
        ref={popRef}
        data-side="right"
        hidden={!open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="ctx-card" ref={cardRef} role="dialog" aria-label="Context window usage">
          <div className="ctx-head">
            <b>Context window</b>
            <span>
              {fmt(total)} / {fmt(limit)}
            </span>
          </div>

          <div className="ctx-bar">
            {segments.map((s) => (
              <i
                key={s.key}
                style={{ width: `${pctOf(Math.min(s.tokens, limit), limit)}%`, background: SEGMENT_COLORS[s.key] }}
              />
            ))}
          </div>
          <div className="ctx-marks" aria-hidden="true">
            <u style={{ left: "70%" }} />
            <u style={{ left: "90%" }} />
          </div>

          <ul className="ctx-rows">
            {segments.map((s) => (
              <li key={s.key}>
                <span className="dot" style={{ background: SEGMENT_COLORS[s.key] }} />
                <span>{s.label}</span>
                <span className="n">{usage?.source === "provider" ? "" : "~"}{fmt(s.tokens)}</span>
                <span className="p">{pctOf(s.tokens, limit).toFixed(1)}%</span>
              </li>
            ))}
            <li className="free">
              <span className="dot" />
              <span>Free space</span>
              <span className="n">{fmt(free)}</span>
              <span className="p">{pctOf(free, limit).toFixed(1)}%</span>
            </li>
          </ul>

          <div className="ctx-meta">
            <div>
              <span>Messages left</span>
              <b>~{fmt(messagesLeft)}</b>
            </div>
            <div>
              <span>Avg message</span>
              <b>{fmt(avgMessage)} tokens</b>
            </div>
            <div>
              <span>Model</span>
              <b>{(usage?.resolvedModel ?? model ?? "auto").split("/").pop()}</b>
            </div>
            {usage?.limitEstimated ? (
              <div>
                <span>Window</span>
                <b>estimated</b>
              </div>
            ) : null}
          </div>

          {note ? (
            <>
              <div className="ctx-note">{note}</div>
              <div className="ctx-actions">
                <button type="button" onClick={compact} disabled={busy !== null} data-ev="ctx:compact">
                  {busy === "compact" ? "Compacting…" : "Compact"}
                </button>
                <button
                  type="button"
                  data-ev="ctx:new"
                  onClick={() => rootRef.current?.dispatchEvent(new CustomEvent("ctx:new", { bubbles: true }))}
                >
                  New chat
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
