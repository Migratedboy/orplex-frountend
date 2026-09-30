// walkthrough.ts — The replayable browser-verification walkthrough.
//
// A walkthrough is a JSON artifact that replays what the verification
// session DID: navigate → interactions → screenshot, one frame per step,
// with the console-error count captured at each step. Antigravity shows a
// proprietary replay; this is the same idea as plain files — frames are
// PNGs on disk, the script is JSON, the drawer renders both.
//
// Pure module: no Playwright, no Node fs — unit-testable everywhere.

export interface WalkthroughFrame {
  /** Step index (0-based). */
  i: number;
  /** navigate | click | scroll | type | wait | screenshot */
  action: string;
  /** Selector / url / value / frame path — human-readable detail. */
  detail?: string;
  /** Frame image path (absolute or relative to the workspace). Null = no frame captured. */
  framePath?: string | null;
  /** Console-error count AFTER this step. */
  errorsAtStep: number;
  /** Errors first seen at this step (delta) — the interesting number. */
  newErrors: number;
  /** Wall-clock offset from session start (ms). */
  atMs: number;
}

export interface Walkthrough {
  version: 1;
  /** Final verdict of the verification session. */
  success: boolean;
  url?: string;
  pageTitle?: string;
  httpStatus?: number;
  durationMs: number;
  /** Per-step record with per-step frames. */
  frames: WalkthroughFrame[];
  /** Console errors verbatim, capped. */
  consoleErrors: string[];
  consoleWarnings: string[];
  /** True when frame files were preserved to a durable location. */
  framesPreserved: boolean;
  /** Root that framePath values are relative to (when not absolute). */
  frameRoot?: string;
}

const MAX_FRAMES = 40;
const MAX_ERROR_LINES = 30;
const MAX_DETAIL = 300;

interface RawStep {
  action: string;
  detail?: string;
  screenshotPath?: string;
  consoleErrorsAtStep: number;
  atMs: number;
}

/**
 * Build a Walkthrough from the verify session's raw timeline + result.
 * Errors per step are computed as deltas so a replay shows exactly when
 * a console error appeared.
 */
export function buildWalkthrough(input: {
  timeline?: RawStep[] | null;
  success: boolean;
  url?: string;
  pageTitle?: string;
  httpStatus?: number;
  durationMs: number;
  consoleErrors: string[];
  consoleWarnings: string[];
}): Walkthrough {
  const steps = (input.timeline ?? []).slice(0, MAX_FRAMES);
  const frames: WalkthroughFrame[] = [];
  let prev = 0;
  for (const s of steps) {
    const errorsAtStep = s.consoleErrorsAtStep;
    frames.push({
      i: frames.length,
      action: String(s.action || "step").slice(0, 40),
      detail: s.detail ? String(s.detail).slice(0, MAX_DETAIL) : undefined,
      framePath: s.screenshotPath ?? null,
      errorsAtStep,
      newErrors: Math.max(0, errorsAtStep - prev),
      atMs: s.atMs,
    });
    prev = errorsAtStep;
  }
  return {
    version: 1,
    success: input.success,
    url: input.url,
    pageTitle: input.pageTitle,
    httpStatus: input.httpStatus,
    durationMs: input.durationMs,
    frames,
    consoleErrors: input.consoleErrors.slice(0, MAX_ERROR_LINES),
    consoleWarnings: input.consoleWarnings.slice(0, MAX_ERROR_LINES),
    framesPreserved: false,
  };
}

/**
 * Rewrite frame paths for durability. Server-run worktrees are DELETED after
 * merge/discard, so frames must live under the user's workspace (served by
 * /api/workspace-file) or another durable root before that happens.
 *
 * `mapPath` receives the original path and returns the durable path (or null
 * to keep the original). Sets framesPreserved when any path was rewritten.
 */
export function rewriteFramePaths(
  wt: Walkthrough,
  mapPath: (original: string) => string | null,
): Walkthrough {
  let any = false;
  const frames = wt.frames.map((f) => {
    if (!f.framePath) return f;
    const mapped = mapPath(f.framePath);
    if (mapped && mapped !== f.framePath) {
      any = true;
      return { ...f, framePath: mapped };
    }
    return f;
  });
  return { ...wt, frames, framesPreserved: wt.framesPreserved || any };
}

/** Compact human-readable transcript for the manifest / export bundle. */
export function walkthroughToText(wt: Walkthrough): string {
  const lines: string[] = [];
  lines.push(`Browser verification walkthrough — ${wt.success ? "PASS" : "FAIL"}`);
  if (wt.url) lines.push(`URL: ${wt.url}`);
  if (wt.pageTitle) lines.push(`Title: ${wt.pageTitle}`);
  lines.push(`Duration: ${wt.durationMs}ms, steps: ${wt.frames.length}`);
  lines.push("");
  for (const f of wt.frames) {
    const at = `${(f.atMs / 1000).toFixed(1)}s`;
    const errs = f.newErrors > 0 ? `  (+${f.newErrors} console error${f.newErrors > 1 ? "s" : ""})` : "";
    lines.push(`${at}  ${f.action}${f.detail ? ` ${f.detail}` : ""}${errs}`);
  }
  if (wt.consoleErrors.length > 0) {
    lines.push("", "Console errors:");
    for (const e of wt.consoleErrors) lines.push(`  - ${e.slice(0, 200)}`);
  }
  return lines.join("\n");
}

/**
 * Plain-language narration of the session — the Antigravity-style summary a
 * reviewer reads BEFORE scrubbing frames. Deterministic, no LLM: composed
 * from the frame timeline (what happened, when errors appeared, verdict).
 */
export function walkthroughNarration(wt: Walkthrough): string {
  const sentences: string[] = [];
  // Cosmetic by contract: malformed/partial walkthroughs narrate what they can.
  const frames = Array.isArray(wt?.frames) ? wt.frames : [];

  // Opening: what page was loaded and how it answered.
  const target = wt.url ? shortenUrl(wt.url) : "the page";
  if (wt.httpStatus !== undefined && wt.httpStatus !== 200) {
    sentences.push(`Loaded ${target} — responded with HTTP ${wt.httpStatus}.`);
  } else {
    sentences.push(`Loaded ${target}${wt.pageTitle ? ` ("${truncate(wt.pageTitle, 60)}")` : ""} successfully.`);
  }

  // Middle: summarize the interactions in order, skipping the navigate frame.
  const interactions = frames.filter(
    (f) => f.action !== "navigate" && f.action !== "wait"
  );
  const counts = new Map<string, number>();
  for (const f of interactions) counts.set(f.action, (counts.get(f.action) || 0) + 1);
  const parts: string[] = [];
  for (const [action, n] of counts) {
    parts.push(n === 1 ? action : `${n}× ${action}`);
  }
  if (parts.length > 0) {
    sentences.push(`Then ${parts.join(", ")}${interactions.length === 1 ? " was performed" : " were performed"}.`);
  }

  // Errors: first frame where new errors appeared.
  const firstError = frames.find((f) => f.newErrors > 0);
  const totalNew = frames.reduce((n, f) => n + (f.newErrors || 0), 0);
  if (totalNew > 0 && firstError) {
    sentences.push(
      `${totalNew} console error${totalNew > 1 ? "s" : ""} appeared at ${(firstError.atMs / 1000).toFixed(1)}s${firstError.detail ? ` while ${firstError.action} ${truncate(firstError.detail, 40)}` : ""}.`
    );
  }

  // Verdict.
  sentences.push(
    totalNew === 0
      ? `Verification passed with a clean console in ${(wt.durationMs / 1000).toFixed(1)}s.`
      : `Verification ${wt.success ? "passed" : "failed"} despite the console errors.`
  );

  return sentences.join(" ");
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : truncate(u.pathname, 40));
  } catch {
    return truncate(url, 50);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
