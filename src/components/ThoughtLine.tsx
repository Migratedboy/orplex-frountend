'use client';

/**
 * ThoughtLine — a thread of thoughts for agents, as translucent glass comments.
 * React 18+ / TypeScript. No deps, no CSS file: styles install themselves once
 * (constructable stylesheet, so no inline <style> for CSP).
 *
 *   import { ThoughtLine, useThoughtLine } from './ThoughtLine';
 *
 *   function Agent() {
 *     let tl = useThoughtLine();
 *     // tl.add({ text: 'Reading the request' })  -> id
 *     // tl.stream(id, 'reasoning tokens...')     -> appends to detail
 *     // tl.add({ text: 'Searching repo', kind: 'tool' })  (auto-completes previous)
 *     // tl.complete() / tl.fail()
 *     return <ThoughtLine thoughts={tl.thoughts} />;
 *   }
 *
 * Or fully controlled: pass your own `Thought[]` (needs startedAt / endedAt in ms).
 *
 * kind:   'think' (circle) | 'tool' (diamond, mono detail) | 'result' (ring)
 * status: 'active' | 'done' | 'error'
 * Live thoughts show their detail streaming, then fold into one line. Click to reopen.
 *
 * Theme with CSS vars on the component or any parent:
 *   --tl-accent  --tl-error  --tl-gap  --tl-node  --tl-glass  --tl-edge
 * Colors otherwise follow the parent's `color`. Glass needs something colorful behind it.
 *
 * SSR (Next.js): styles are installed on the client. To have them on first paint,
 * put `thoughtLineCss` into your global stylesheet / <style nonce> yourself.
 */

import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

/* ------------------------------------------------------------------ types */

export type ThoughtKind = 'think' | 'tool' | 'result';
export type ThoughtStatus = 'active' | 'done' | 'error';

export interface Thought {
  id: string;
  text: string;
  detail?: string;
  kind?: ThoughtKind;
  status: ThoughtStatus;
  /** ms epoch */
  startedAt: number;
  /** ms epoch; null/undefined while active */
  endedAt?: number | null;
  /**
   * Optional Material Symbols ligature name ("description", "edit", …) shown
   * in the node instead of the default shape. Additive: a thought without a
   * glyph renders exactly as before.
   */
  glyph?: string;
}

export interface ThoughtInput {
  id?: string;
  text: string;
  detail?: string;
  kind?: ThoughtKind;
  status?: ThoughtStatus;
  /** ms. If given (and status isn't 'error'), the thought is created already done. */
  duration?: number;
  /** Optional Material Symbols ligature name for the node (see Thought). */
  glyph?: string;
}

export interface ThoughtPatch {
  text?: string;
  detail?: string;
  kind?: ThoughtKind;
  status?: 'done' | 'error';
  glyph?: string;
}

/* ------------------------------------------------------------------ styles */

export const thoughtLineCss = `
.tl, .tl *, .tl *::before, .tl *::after { box-sizing: border-box; }
.tl {
  --_accent: var(--tl-accent, #f26a0f);
  --_error: var(--tl-error, #d92d4a);
  --_gap: var(--tl-gap, 16px);
  --_node: var(--tl-node, 11px);
  --_nt: 13px;
  --_line: color-mix(in srgb, var(--_accent) 45%, transparent);
  --_glass: var(--tl-glass, color-mix(in srgb, currentColor 8%, transparent));
  --_edge: var(--tl-edge, color-mix(in srgb, currentColor 18%, transparent));
  list-style: none;
  margin: 0;
  padding: 0;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 1.45;
}

.tl-item {
  position: relative;
  display: grid;
  grid-template-columns: var(--_node) minmax(0, 1fr);
  column-gap: 12px;
  padding-bottom: var(--_gap);
}
.tl-item:last-child { padding-bottom: 0; }

/* the thread: from under this node to just above the next one */
.tl-item::before {
  content: "";
  position: absolute;
  left: calc(var(--_node) / 2 - 0.75px);
  top: calc(var(--_nt) + var(--_node) + 3px);
  bottom: calc(3px - var(--_nt));
  width: 1.5px;
  background: var(--_line);
  transform-origin: top;
  animation: tl-draw 0.45s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.tl-item:last-child::before { display: none; }
/* trailing thread on the live thought: fades out, says "more is coming" */
.tl-item:last-child[data-status="active"]::before {
  display: block;
  bottom: auto;
  height: 26px;
  background: linear-gradient(var(--_accent), transparent);
}

.tl-node {
  position: relative;
  z-index: 1;
  width: var(--_node);
  height: var(--_node);
  margin-top: var(--_nt);
  border: 1.5px solid transparent;
  border-radius: 50%;
  background: color-mix(in srgb, currentColor 55%, transparent);
  transition: background 0.25s, border-color 0.25s, transform 0.25s;
}
.tl-item[data-kind="tool"] .tl-node { border-radius: 2px; transform: rotate(45deg) scale(0.8); }
.tl-item[data-kind="result"] .tl-node {
  background: transparent;
  border-width: 2px;
  border-color: var(--_accent);
}
.tl-item[data-status="active"] .tl-node {
  background: var(--_accent);
  border-color: var(--_accent);
  animation: tl-breathe 1.6s ease-in-out infinite;
}
.tl-item[data-kind="result"][data-status="active"] .tl-node { background: transparent; }
.tl-item[data-status="error"] .tl-node,
.tl-item[data-kind="result"][data-status="error"] .tl-node {
  background: var(--_error);
  border-color: var(--_error);
  animation: none;
}

/* each thought is a translucent system comment */
.tl-body {
  min-width: 0;
  padding: 8px 12px;
  border-radius: 14px;
  border: 1px solid var(--_edge);
  background: var(--_glass);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent),
    0 10px 28px -14px color-mix(in srgb, var(--_accent) 65%, transparent);
  transition: background 0.3s, border-color 0.3s;
  animation: tl-fade 0.3s ease-out;
}
.tl-item[data-status="active"] .tl-body {
  border-color: color-mix(in srgb, var(--_accent) 60%, transparent);
  background:
    linear-gradient(color-mix(in srgb, var(--_accent) 16%, transparent), color-mix(in srgb, var(--_accent) 16%, transparent)),
    var(--_glass);
}
.tl-item[data-status="error"] .tl-body {
  border-color: color-mix(in srgb, var(--_error) 55%, transparent);
  background:
    linear-gradient(color-mix(in srgb, var(--_error) 14%, transparent), color-mix(in srgb, var(--_error) 14%, transparent)),
    var(--_glass);
}

.tl-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
.tl-head:disabled { color: inherit; }
.tl-item[data-has-detail] .tl-head { cursor: pointer; }
.tl-head:focus-visible {
  outline: 2px solid var(--_accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.tl-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tl-item[data-status="done"] .tl-text { color: color-mix(in srgb, currentColor 72%, transparent); }
.tl-item[data-status="error"] .tl-text { color: var(--_error); }
.tl-item[data-kind="result"][data-status="done"] .tl-text { color: inherit; font-weight: 600; }

.tl-meta {
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
  white-space: nowrap;
}

.tl-chev {
  display: none;
  flex: none;
  align-self: center;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: 0.5;
  transform: translateY(-1px) rotate(-45deg);
  transition: transform 0.2s;
}
.tl-item[data-has-detail] .tl-chev { display: block; }
.tl-head[aria-expanded="true"] .tl-chev { transform: translateY(-2px) rotate(45deg); }

.tl-detail {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.tl-detail[data-open] { grid-template-rows: 1fr; }
/* visibility keeps collapsed text out of the tab order and a11y tree */
.tl-detail-inner {
  min-height: 0;
  overflow: hidden;
  visibility: hidden;
  transition: visibility 0s linear 0.25s;
}
.tl-detail[data-open] .tl-detail-inner { visibility: visible; transition-delay: 0s; }

.tl-detail-text {
  margin: 6px 0 2px;
  padding-left: 12px;
  border-left: 1.5px solid color-mix(in srgb, var(--_accent) 45%, transparent);
  font-size: 13.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: color-mix(in srgb, currentColor 80%, transparent);
}
.tl-item[data-kind="tool"] .tl-detail-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.tl-item[data-status="active"] .tl-detail-text::after {
  content: "";
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--_accent);
  animation: tl-blink 1s steps(2, start) infinite;
}

.tl-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes tl-draw { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes tl-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tl-blink { to { visibility: hidden; } }
@keyframes tl-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--_accent) 55%, transparent); }
  50% { box-shadow: 0 0 0 5px transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .tl *, .tl *::before, .tl *::after { animation: none !important; transition: none !important; }
}
`;

let stylesInstalled = false;

function installStyles(nonce?: string) {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  try {
    if ('adoptedStyleSheets' in document) {
      let sheet = new CSSStyleSheet();
      sheet.replaceSync(thoughtLineCss);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    /* fall through to <style> */
  }
  let el = document.createElement('style');
  if (nonce) el.nonce = nonce;
  el.textContent = thoughtLineCss;
  document.head.appendChild(el);
}

/* --------------------------------------------------------------- component */

function fmt(ms: number) {
  let s = Math.max(0, ms) / 1000;
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
}

export interface ThoughtLineProps {
  thoughts: Thought[];
  /** fired when the user opens/closes a thought */
  onToggle?: (id: string, open: boolean) => void;
  /** accessible name for the log */
  label?: string;
  /** CSP nonce, only used if the browser has no constructable stylesheets */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
}

export function ThoughtLine({
  thoughts = [],
  onToggle,
  label = 'Thought line',
  nonce,
  className,
  style,
}: ThoughtLineProps) {
  useInsertionEffect(() => {
    installStyles(nonce);
  }, [nonce]);

  let [userOpen, setUserOpen] = useState<Record<string, boolean>>({});
  let [now, setNow] = useState(() => Date.now());

  let live = thoughts.some((t) => t.status === 'active');
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    let h = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(h);
  }, [live]);

  useEffect(() => {
    if (thoughts.length === 0) setUserOpen((m) => (Object.keys(m).length ? {} : m));
  }, [thoughts.length]);

  let toggle = (id: string, next: boolean) => {
    setUserOpen((m) => ({ ...m, [id]: next }));
    onToggle?.(id, next);
  };

  return (
    <ol
      className={className ? 'tl ' + className : 'tl'}
      style={style}
      role="log"
      aria-label={label}
    >
      {thoughts.map((t) => {
        let has = !!t.detail;
        // live reasoning is visible, then folds into the line
        let open = has && (userOpen[t.id] ?? t.status === 'active');
        let end = t.endedAt ?? (t.status === 'active' ? now : null);
        return (
          <li
            key={t.id}
            className="tl-item"
            data-status={t.status}
            data-kind={t.kind ?? 'think'}
            data-has-detail={has ? '' : undefined}
          >
            <span className="tl-node" aria-hidden="true">
              {t.glyph ? <span className="ms">{t.glyph}</span> : null}
            </span>
            <div className="tl-body">
              <button
                type="button"
                className="tl-head"
                disabled={!has}
                aria-expanded={open}
                onClick={() => toggle(t.id, !open)}
              >
                <span className="tl-sr">
                  {t.status === 'active' ? 'In progress: ' : t.status === 'error' ? 'Failed: ' : ''}
                </span>
                <span className="tl-text">{t.text}</span>
                {end != null && (
                  <span className="tl-meta" suppressHydrationWarning>
                    {fmt(end - t.startedAt)}
                  </span>
                )}
                <span className="tl-chev" aria-hidden="true" />
              </button>
              <div className="tl-detail" data-open={open ? '' : undefined}>
                <div className="tl-detail-inner">
                  <div className="tl-detail-text">{t.detail}</div>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------- hook */

function build(o: ThoughtInput, now: number, id: string): Thought {
  let hasDur = typeof o.duration === 'number' && !Number.isNaN(o.duration);
  let status: ThoughtStatus =
    o.status === 'error' ? 'error' : o.status === 'done' || hasDur ? 'done' : 'active';
  return {
    id,
    text: o.text,
    detail: o.detail ?? '',
    kind: o.kind ?? 'think',
    status,
    startedAt: now,
    endedAt: status === 'active' ? null : now + (hasDur ? (o.duration as number) : 0),
    glyph: o.glyph,
  };
}

function patchThought(t: Thought, p: ThoughtPatch, now: number): Thought {
  let n: Thought = { ...t };
  if (p.text !== undefined) n.text = p.text;
  if (p.detail !== undefined) n.detail = p.detail;
  if (p.kind !== undefined) n.kind = p.kind;
  if (p.glyph !== undefined) n.glyph = p.glyph;
  if ((p.status === 'done' || p.status === 'error') && t.status === 'active') {
    n.status = p.status;
    n.endedAt = now;
  }
  return n;
}

export interface UseThoughtLineOptions {
  /** don't auto-complete the previous thought when adding a new one */
  manual?: boolean;
}

export function useThoughtLine(options?: UseThoughtLineOptions) {
  let [thoughts, setThoughts] = useState<Thought[]>([]);
  let counter = useRef(0);
  let manualRef = useRef(false);
  manualRef.current = !!options?.manual;

  let add = useCallback((input: string | ThoughtInput): string => {
    let o: ThoughtInput = typeof input === 'string' ? { text: input } : input;
    let id = o.id ?? 't' + ++counter.current;
    let now = Date.now();
    let manual = manualRef.current;
    setThoughts((prev) => {
      if (prev.some((t) => t.id === id)) {
        return prev.map((t) =>
          t.id === id
            ? patchThought(
                t,
                {
                  text: o.text,
                  detail: o.detail,
                  kind: o.kind,
                  glyph: o.glyph,
                  status: o.status === 'done' || o.status === 'error' ? o.status : undefined,
                },
                now
              )
            : t
        );
      }
      let base = manual
        ? prev
        : prev.map((t) =>
            t.status === 'active' ? { ...t, status: 'done' as const, endedAt: now } : t
          );
      return [...base, build(o, now, id)];
    });
    return id;
  }, []);

  let update = useCallback((id: string, patch: ThoughtPatch) => {
    let now = Date.now();
    setThoughts((prev) => prev.map((t) => (t.id === id ? patchThought(t, patch, now) : t)));
  }, []);

  let stream = useCallback((id: string, chunk: string, field: 'detail' | 'text' = 'detail') => {
    setThoughts((prev) =>
      prev.map((t) =>
        t.id !== id
          ? t
          : field === 'text'
            ? { ...t, text: t.text + chunk }
            : { ...t, detail: (t.detail ?? '') + chunk }
      )
    );
  }, []);

  let complete = useCallback((id?: string, status: 'done' | 'error' = 'done') => {
    let now = Date.now();
    setThoughts((prev) => {
      let idx = -1;
      if (id != null) {
        idx = prev.findIndex((t) => t.id === id);
      } else {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].status === 'active') {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0 || prev[idx].status !== 'active') return prev;
      let next = prev.slice();
      next[idx] = { ...prev[idx], status, endedAt: now };
      return next;
    });
  }, []);

  let fail = useCallback((id?: string) => complete(id, 'error'), [complete]);

  let clear = useCallback(() => setThoughts([]), []);

  let set = useCallback((list: ThoughtInput[]) => {
    let now = Date.now();
    setThoughts(list.map((o) => build(o, now, o.id ?? 't' + ++counter.current)));
  }, []);

  return { thoughts, add, update, stream, complete, fail, clear, set };
}

/* -------------------------------------------------------------------- demo */

type Step = { text: string; kind?: ThoughtKind; detail?: string; ms: number; fail?: boolean };

const SCRIPT: Step[] = [
  { text: 'Reading the request', detail: 'Retry logic should live in one place.\nCheck every caller before moving anything.', ms: 500 },
  { text: 'Searching for fetchWithRetry', kind: 'tool', detail: '$ grep -rn "fetchWithRetry" src/\nsrc/api/client.js:14\nsrc/api/upload.js:32\nsrc/jobs/sync.js:8\nsrc/jobs/poll.js:21', ms: 600 },
  { text: 'Four call sites, one relies on default backoff', detail: 'poll.js passes no options, so it depends on the 3-attempt default.\nKeep that default in the new module.', ms: 500 },
  { text: 'Writing src/net/retry.js', kind: 'tool', detail: 'create src/net/retry.js\nupdate src/api/client.js\nupdate src/jobs/*.js', ms: 700 },
  { text: 'Running tests', kind: 'tool', detail: '$ npm test\nFAIL  src/jobs/poll.test.js\nCannot find module "../api/retry"', ms: 600, fail: true },
  { text: 'Stale import in poll.test.js', detail: 'Test still imports the old path.\nPoint it at src/net/retry.js.', ms: 500 },
  { text: 'Running tests again', kind: 'tool', detail: '$ npm test\nPASS  12 suites, 48 tests', ms: 600 },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Drop <ThoughtLineDemo /> on a page to see it run. */
export function ThoughtLineDemo() {
  let { thoughts, add, stream, complete, fail, clear } = useThoughtLine();
  let token = useRef(0);
  let [running, setRunning] = useState(false);

  let play = async () => {
    let my = ++token.current;
    clear();
    setRunning(true);
    for (let s of SCRIPT) {
      if (my !== token.current) return;
      let id = add({ text: s.text, kind: s.kind });
      let d = s.detail ?? '';
      for (let i = 0; i < d.length; i += 3) {
        if (my !== token.current) return;
        stream(id, d.slice(i, i + 3));
        await sleep(22);
      }
      await sleep(s.ms);
      if (my !== token.current) return;
      if (s.fail) fail(id);
    }
    if (my !== token.current) return;
    add({ text: 'Retry now lives in one place. All tests pass.', kind: 'result' });
    complete();
    setRunning(false);
  };

  let reset = () => {
    token.current++;
    clear();
    setRunning(false);
  };

  useEffect(() => {
    play();
    return () => {
      token.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let btn: CSSProperties = {
    font: 'inherit',
    fontSize: 14,
    padding: '8px 16px',
    borderRadius: 8,
    border: '1px solid rgba(42,26,16,0.25)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: '#2a1a10',
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        background:
          'radial-gradient(440px circle at 28% 24%, #ff8a3dcc, transparent 70%), radial-gradient(400px circle at 76% 82%, #ffb877aa, transparent 70%), #ffffff',
      }}
    >
      <main style={{ width: 'min(480px, 100%)', padding: '32px 24px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 600 }}>
          Move retry logic out of the fetch wrapper
        </h1>
        <p style={{ margin: '0 0 28px', fontSize: 14, color: '#8a6a55' }}>
          Click a finished step to reopen its reasoning.
        </p>

        <div style={{ minHeight: 300 }}>
          <ThoughtLine
            thoughts={thoughts}
            style={
              {
                '--tl-glass': 'rgba(255,255,255,0.6)',
                '--tl-edge': 'rgba(242,106,15,0.3)',
              } as CSSProperties
            }
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <button
            type="button"
            style={{ ...btn, background: '#d94f00', borderColor: '#d94f00', color: '#ffffff', fontWeight: 600, opacity: running ? 0.5 : 1 }}
            disabled={running}
            onClick={play}
          >
            Run agent
          </button>
          <button type="button" style={btn} onClick={reset}>
            Reset
          </button>
        </div>
      </main>
    </div>
  );
}

// Default export is the demo so previews (e.g. Claude artifacts) render a live run.
// In your app, use the named imports: { ThoughtLine, useThoughtLine }.
export default ThoughtLineDemo;
