// error-guidance.ts — one shared vocabulary for failure modes across the app.
//
// Every recoverable failure the product knows about maps to a Guidance entry:
// a one-line "what happened", a one-line "what to do", and which recovery
// action(s) the UI can offer as one-click buttons. StateViews, the Manager
// health strip, and tool-result "Why did this happen?" links all render from
// here so copy never diverges between surfaces.
//
// Matching is intentionally fuzzy (regex over the raw message): the same
// underlying failure reaches the UI through many transports (SSE events, HTTP
// error JSON, terminal exit codes), and we'd rather over-match an honest
// generic entry than show raw jargon.

export type RecoveryActionId =
  | "retry"
  | "kill-port"
  | "open-settings-keys"
  | "clear-stuck-runs"
  | "approve-pending"
  | "check-workspace"
  | "reduce-scope"
  | "reconnect";

export interface ErrorGuidance {
  /** Short label, e.g. shown as the bold first line. */
  title: string;
  /** One sentence: what actually happened, in product language. */
  what: string;
  /** One sentence: the fastest way out. */
  fix: string;
  /** One-click recovery actions the UI should offer, in display order. */
  actions: RecoveryActionId[];
  /** Deep-link target (docs / settings route) for "Why did this happen?". */
  learnMore?: string;
}

const GUIDANCE: Array<{ id: string; match: RegExp; guidance: ErrorGuidance }> = [
  {
    id: "ssrf-blocked",
    match: /\b(ssrf|blocked (by the )?(ssrf|url|network) (guard|policy|filter)|private (ip|network|address) (is )?not allowed|loopback|169\.254|127\.0\.0\.1.*forbidden)/i,
    guidance: {
      title: "Blocked for safety",
      what: "The agent tried to reach a private/internal address, which is blocked to protect your machine and network.",
      fix: "If this resource is genuinely needed, expose it over a public URL or allowlist it in Settings → Security.",
      actions: ["retry", "open-settings-keys"],
      learnMore: "/settings",
    },
  },
  {
    id: "port-conflict",
    match: /\b(eaddrinuse|port .* (is )?(already )?(in use|taken|busy)|listen eaddrinuse)/i,
    guidance: {
      title: "Port already in use",
      what: "Something else on your machine is already listening on the port the agent needed.",
      fix: "Stop the other process (or let Orplex pick the port) and run again.",
      actions: ["kill-port", "retry"],
    },
  },
  {
    id: "tool-loop-cap",
    match: /\b(tool[- ]loop|loop (cap|limit|guard)|too many (tool|consecutive|repeated) (calls|attempts)|max (tool|iteration)s? (reached|exceeded)|stuck in a loop)/i,
    guidance: {
      title: "Agent hit its attempt limit",
      what: "The agent repeated the same action too many times and stopped itself to avoid burning tokens in circles.",
      fix: "Add a hint to the task (a file path, an error message) and continue — the agent resumes with that context.",
      actions: ["retry", "reduce-scope"],
    },
  },
  {
    id: "tpm-exhausted",
    match: /\b(tpm|tokens? per minute|rate.?limit|quota (exceeded|exhausted)|429|resource_exhausted|too many requests)/i,
    guidance: {
      title: "Model rate limit reached",
      what: "The model provider throttled requests — usually too many tokens in one minute, not a bill.",
      fix: "Wait ~60 seconds, then resume. Connecting your own API key removes shared-quota throttling.",
      actions: ["retry", "open-settings-keys"],
      learnMore: "/settings",
    },
  },
  {
    id: "approval-timeout",
    match: /\b(approval (timed? ?out|expired)|waiting for (approval|review) .*timed?|no response to (the )?approval)/i,
    guidance: {
      title: "Approval request expired",
      what: "The agent paused for your review and no decision arrived in time, so it moved on safely.",
      fix: "Approve or reject the pending change to let the run continue from where it paused.",
      actions: ["approve-pending"],
    },
  },
  {
    id: "ghost-run",
    match: /\b(ghost|orphan(ed)? run|stale (run|agent|executor)|run (is )?stuck|heartbeat (lost|timeout)|executor (died|disconnected|unreachable))/i,
    guidance: {
      title: "Run lost connection",
      what: "This run stopped receiving updates — its executor likely died or the app restarted mid-run.",
      fix: "Clear the stuck run; nothing was left half-written in your workspace.",
      actions: ["clear-stuck-runs"],
    },
  },
  {
    id: "no-workspace",
    match: /\b(no (folder|workspace|project) (is )?open|open a folder|workspace (not|not yet) (open|loaded))/i,
    guidance: {
      title: "No workspace open",
      what: "The agent can only read and edit files once you open a project folder.",
      fix: "Open a folder (sidebar → Open, or Ctrl+O) and re-run the task.",
      actions: ["check-workspace"],
    },
  },
  {
    id: "network",
    match: /\b(fetch failed|network|econnrefused|enotfound|etimedout|socket hang up|offline|dns)/i,
    guidance: {
      title: "Connection problem",
      what: "Orplex couldn't reach the model service — your network dropped or the endpoint refused the connection.",
      fix: "Check your connection, then retry. The conversation is preserved.",
      actions: ["retry", "reconnect"],
    },
  },
];

/** Generic fallback so no failure ever renders as raw jargon. */
const FALLBACK: ErrorGuidance = {
  title: "Something went wrong",
  what: "The task stopped with an unexpected error.",
  fix: "Retry once — if it repeats, report it from the Help menu so we can see the exact error.",
  actions: ["retry"],
};

const LEARN_MORE_PREFIX = "/settings"; // in-app deep link target for now

/**
 * Match a raw error string (message, stack, terminal output — anything) to
 * guidance. Returns null for empty/noise input; callers decide the fallback.
 */
export function guidanceFor(raw: string | null | undefined): ErrorGuidance | null {
  const text = (raw || "").slice(0, 2000);
  if (!text.trim()) return null;
  for (const g of GUIDANCE) {
    if (g.match.test(text)) return g.guidance;
  }
  return null;
}

/** Like guidanceFor but never returns null — falls back to the generic entry. */
export function guidanceOrFallback(raw: string | null | undefined): ErrorGuidance {
  return guidanceFor(raw) ?? FALLBACK;
}

/** Human label + icon (Material Symbols name) per recovery action id. */
export const RECOVERY_ACTION_META: Record<RecoveryActionId, { label: string; icon: string }> = {
  retry: { label: "Retry", icon: "refresh" },
  "kill-port": { label: "Free the port", icon: "power_off" },
  "open-settings-keys": { label: "Open Settings", icon: "settings" },
  "clear-stuck-runs": { label: "Clear stuck runs", icon: "cleaning_services" },
  "approve-pending": { label: "Review pending changes", icon: "approval" },
  "check-workspace": { label: "Open a folder", icon: "folder_open" },
  "reduce-scope": { label: "Continue with a hint", icon: "edit_note" },
  reconnect: { label: "Reconnect", icon: "wifi" },
};

/** Where each recovery action routes (openSettings keys are query params). */
export function recoveryTarget(action: RecoveryActionId): { href?: string; event?: string } {
  switch (action) {
    case "open-settings-keys":
      return { href: "/settings" };
    case "clear-stuck-runs":
      return { href: "/settings?tab=danger" };
    case "approve-pending":
      return { event: "orplex:open-approvals" };
    case "check-workspace":
      return { event: "orplex:open-folder" };
    default:
      return { event: LEARN_MORE_PREFIX ? "orplex:guidance-retry" : undefined };
  }
}
