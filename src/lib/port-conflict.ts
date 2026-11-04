/**
 * port-conflict.ts — THE single diagnosePortConflict for both agent lanes
 * (blocking exec in background-worker.ts and the serve lane's run_command in
 * agent/serve-helpers.ts).
 *
 * History: the two lanes had diverged copies. The serve lane's copy was fixed
 * first — bare "permission denied" is a file-system or install-cache problem
 * (npm cache, /root write access), and telling the model to kill a process
 * sent users chasing the wrong thing. The worker copy kept matching it and
 * kept producing the wrong hint. This module adopts the FIXED behavior for
 * both lanes (deliberate behavior change in the worker lane, signed off as
 * part of Operation Modularity): only REAL port evidence triggers the hint.
 *
 * The hint text itself ships to the model — changing it is a behavior change
 * and must be deliberate. Tests pin it in serve-lane.test.ts.
 */

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
