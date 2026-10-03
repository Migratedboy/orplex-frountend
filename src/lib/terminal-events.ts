// terminal-events.ts — One visible stream for EVERYTHING that runs.
//
// The agent's run_command/serve calls and the user's typed input are different
// authors of the same terminal. Both publish here; the Terminal tab is the
// single subscriber that paints them. Mirrors the preview-event pattern in
// agent-events.ts. Pure pub/sub — safe in Node, browser, and tests alike.

export type TerminalLineType = "cmd" | "stdout" | "stderr" | "done" | "error" | "info";
export type TerminalLineSource = "agent" | "user";

export interface TerminalLineEvent {
  type: TerminalLineType;
  /** Command text, output chunk, or status message. */
  text: string;
  source: TerminalLineSource;
  at: number;
}

type Listener = (event: TerminalLineEvent) => void;

let listeners: Listener[] = [];

export function onTerminalEvent(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function emitTerminalLine(
  type: TerminalLineType,
  text: string,
  source: TerminalLineSource
): void {
  const event: TerminalLineEvent = { type, text, source, at: Date.now() };
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {}
  }
}
