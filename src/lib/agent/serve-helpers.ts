// serve-helpers.ts — Server-lane helpers extracted from background-worker.ts.

/**
 * Commands that start long-running servers. These must go through the
 * detached serve lane (/api/agent/serve), never blocking exec — a server
 * never exits, so exec would kill it at the timeout and orphan the child.
 */
export function isServerCommand(command: string): boolean {
  return /(^|\s)(npx\s+serve|serve\s|npm\s+run\s+dev|npm\s+run\s+start|npm\s+start\b|next\s+dev|next\s+start|vite(\s|$)|python3?\s+(-\w+\s+)*-?m\s+http\.server|flask\s+run|uvicorn(\s|$)|php\s+-S|http-server(\s|$)|json-server(\s|$)|live-server(\s|$))/.test(command);
}

/**
 * Detect EADDRINUSE/EACCES port conflicts in command output and append an
 * actionable hint (find the PID via netstat, or use the serve lane).
 *
 * The implementation lives in ../port-conflict — the ONE copy shared with
 * background-worker's blocking-exec lane. Keep this re-export: native-tools
 * and the agent contract import the helper from here (serve-lane namespace).
 */
export { diagnosePortConflict } from "../port-conflict";
