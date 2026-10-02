// compaction-memory.ts — Auto-capture durable facts when context is evicted.
//
// When the transcript outgrows the TPM budget, compaction summarizes the
// evicted prefix into a <context_so_far> block. That summary already
// contains the distilled facts — capturing 1-3 durable learnings from it
// into workspace-memory costs zero extra model calls and means evicted
// context is remembered at the NEXT run, not just this one.

import { captureWorkspaceMemories } from "./workspace-memory";
import { getWorkspaceKey } from "./run-ledger";

/** Extract candidate facts from a compaction summary. Pure, deterministic. */
export function extractEvictionFacts(summary: string): string[] {
  const facts: string[] = [];
  const lines = summary.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (facts.length >= 3) break;
    // Decision/pitfall markers the compaction prompt encourages.
    const decision = /^(?:[-*]\s*)?(?:decision|chose|decided|use|prefer)\b/i.test(line);
    const pitfall = /^(?:[-*]\s*)?(?:avoid|never|do not|don't|fails|error|pitfall)\b/i.test(line);
    if (!decision && !pitfall) continue;
    // Length-check the STORED fact (prefix stripped), not the raw line.
    const fact = line.replace(/^[-*]\s*/, "").slice(0, 400);
    if (fact.length < 25 || fact.length > 400) continue;
    facts.push(fact);
  }
  return facts;
}

/**
 * Fire-and-forget capture from a compaction summary. Best-effort: any DB
 * error is swallowed — memory must never break a run.
 */
export async function captureFromCompaction(opts: {
  directoryName: string;
  summary: string;
}): Promise<number> {
  if (!opts.summary || opts.summary.length < 60) return 0;
  const facts = extractEvictionFacts(opts.summary);
  if (facts.length === 0) return 0;
  try {
    const { captureWorkspaceMemories: capture } = await import("./workspace-memory");
    return await capture({
      workspaceKey: getWorkspaceKey(opts.directoryName),
      task: "auto-captured from compacted context",
      writtenFiles: {},
      lanes: {},
      finalStatus: "done",
      acceptedSuggestions: facts,
    });
  } catch {
    return 0;
  }
}
