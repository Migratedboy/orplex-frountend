/**
 * safe-io.ts — the main process can outlive the console/pipes it was born
 * with. A closed parent terminal, a detached launch, or a dev restart leaves
 * stdout/stderr pointing at a broken pipe; the next write throws EPIPE as an
 * UNCAUGHT exception and Electron paints the fatal-sounding "A JavaScript
 * error occurred in the main process" dialog (EPIDE "broken pipe, write").
 *
 * Console output is diagnostics, never critical work — every stdout/stderr
 * write here goes through safeConsoleWrite, and installPipeResilience is a
 * process-level safety net so an EPIPE from any OTHER stream (a socket the
 * renderer relayed, a WebContents stdout pipe) can still never kill the app.
 */

/** Best-effort write to stdout/stderr: the line is dropped, never thrown, on a broken pipe. */
export function safeConsoleWrite(
  stream: NodeJS.WriteStream | null | undefined,
  text: string,
): void {
  try {
    stream?.write(text);
  } catch {
    /* pipe gone — drop the line */
  }
}

/**
 * Swallow pipe-death uncaughts process-wide. Registered once, early in main.
 * EPIPE / ECONNRESET are the two codes a dying pipe produces; everything else
 * is logged to stderr (best-effort) and left for the default handler.
 */
export function installPipeResilience(): void {
  process.on("uncaughtException", (err: unknown) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPIPE" || code === "ECONNRESET") return;
    safeConsoleWrite(process.stderr, `[main] uncaught: ${(err as Error)?.stack || String(err)}\n`);
  });
}
