// runtime-log.ts — Ring-buffer logging API over the shared runtime state.
//
// State itself lives in runtime-state.ts (globalThis-persisted) so dev-mode
// bundle duplication can't fragment it. See that file for the rationale.

import { runtimeState } from "./runtime-state";
import type { RuntimeLogEntry, RuntimeComponent, RuntimeLogLevel } from "./runtime-state";

export type { RuntimeLogEntry, RuntimeComponent, RuntimeLogLevel };

const RUNTIME_LOG_CAP = 200;

/** Record a runtime event. Never throws; trims to the cap. */
export function recordRuntimeLog(component: RuntimeComponent, level: RuntimeLogLevel, message: string): void {
  runtimeState.logs.push({
    ts: new Date().toISOString(),
    component,
    level,
    message: message.slice(0, 500),
  });
  if (runtimeState.logs.length > RUNTIME_LOG_CAP) {
    runtimeState.logs.splice(0, runtimeState.logs.length - RUNTIME_LOG_CAP);
  }
}

/** Newest-first slice of the buffer. */
export function getRuntimeLogs(limit = 100): RuntimeLogEntry[] {
  return runtimeState.logs.slice(-Math.max(1, Math.min(limit, RUNTIME_LOG_CAP))).reverse();
}

/** Current buffer depth (for the System page's "N events buffered" hint). */
export function runtimeLogCount(): number {
  return runtimeState.logs.length;
}

/** Tests only. */
export function clearRuntimeLogs(): void {
  runtimeState.logs.length = 0;
}
