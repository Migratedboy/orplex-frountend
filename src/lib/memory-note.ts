// memory-note.ts — One-shot "why did this fail?" note for low-RAM hosts.
//
// System memory is read server-side (os.freemem — see hardware.ts); the chat
// failure path runs in the renderer, so it asks the tiny public
// /api/system/memory route for the percentage at failure time. Any failure to
// get it (no server, Jest, session hiccup) degrades silently to null — the
// error message then ships without the memory note, never worse than before.

/** Message appended to failures while the machine is low on RAM. */
export async function lowMemoryNote(): Promise<string | null> {
  try {
    const res = await fetch("/api/system/memory", {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      usedPercent?: number;
      lowMemory?: boolean;
    };
    if (!data?.lowMemory || typeof data.usedPercent !== "number") return null;
    return `Low memory: system RAM at ${data.usedPercent}% used`;
  } catch {
    return null;
  }
}
