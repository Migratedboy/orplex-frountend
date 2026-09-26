// agent-events.ts — Status emission and event system for agent progress display
// Emits structured events that the frontend subscribes to for real-time progress

// === Status step and activity types ===

export type StatusStep = {
  type: "step";
  agent: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
};

export type StatusActivity = {
  type: "activity";
  entry: { timestamp: number; type: string; message: string; agent?: string };
};

export type StatusEvent = StatusStep | StatusActivity;

// === Status listeners ===

let _statusListeners: Array<(event: StatusEvent) => void> = [];

export function onAgentStatus(listener: (event: StatusEvent) => void): () => void {
  _statusListeners.push(listener);
  return () => {
    _statusListeners = _statusListeners.filter((l) => l !== listener);
  };
}

export function emitStatus(event: StatusEvent) {
  for (const listener of _statusListeners) {
    try {
      listener(event);
    } catch {}
  }
}

export function emitActivity(entry: {
  type: string;
  message: string;
  agent?: string;
}) {
  emitStatus({
    type: "activity",
    entry: { ...entry, timestamp: Date.now() },
  });
}

// === Live preview events ===
// The agent can drive the user's Preview panel. preview_browser and
// take_screenshot emit here; the RightPanel PreviewTab listens and navigates
// its live iframe — turning static screenshots into an embedded browser.

export interface PreviewEvent {
  url: string;
  source: "preview_browser" | "take_screenshot" | "verify_app";
  timestamp: number;
}

let _previewListeners: Array<(event: PreviewEvent) => void> = [];

export function onPreviewEvent(
  listener: (event: PreviewEvent) => void
): () => void {
  _previewListeners.push(listener);
  return () => {
    _previewListeners = _previewListeners.filter((l) => l !== listener);
  };
}

export function emitPreview(url: string, source: PreviewEvent["source"]) {
  const event: PreviewEvent = { url, source, timestamp: Date.now() };
  for (const listener of _previewListeners) {
    try {
      listener(event);
    } catch {}
  }
}
