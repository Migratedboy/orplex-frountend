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
 */
export function diagnosePortConflict(command: string, output: string): string {
  const o = (output || "").toLowerCase();
  const portMatch =
    command.match(/(?:-l|--listen|-p|--port)\s+(\d{2,5})/) ||
    command.match(/http\.server\s+(\d{2,5})/) ||
    command.match(/:\s?(\d{4,5})\b/);
  const port = portMatch ? portMatch[1] : null;
  // Only REAL port evidence. "permission denied" on its own is a file-system
  // or install-cache problem (npm cache, /root write access) and telling the
  // model to kill a process sent users chasing the wrong thing.
  const isConflict =
    /eaddrinuse|address already in use|port is already in use|listen eacces/.test(o);
  if (!isConflict) return "";
  if (port) {
    return `\n\n[HINT] Port ${port} is taken — likely a zombie server from an earlier attempt. Find and kill it: run_command({ command: "netstat -ano | findstr :${port}" }) then run_command({ command: "taskkill /PID <pid> /T /F" }) (Windows) — or serve on another port.`;
  }
  return "\n\n[HINT] The port is taken by an older process — pick a different port or stop the old server first.";
}
