/**
 * reliability/provenance.ts — Phase 4: provenance labels + taint tracking.
 *
 * AUDIT.md §Phase4 rows "Provenance labels: ABSENT" and "Taint policy: ABSENT"
 * — before this module there were zero hits for "provenance" in agent code,
 * and six distinct call origins (native XML, XML-in-prose, bare-JSON recovery,
 * orchestrator, directive-prompted, repair lane) were indistinguishable at the
 * dispatch site. A `<tool_call>` smuggled into prose executed with full authority
 * because nothing could tell it apart from a user-typed request.
 *
 * This module is the pure ledger the call sites report into:
 *  - the Provenance union labels WHERE a tool call came from (call-site duty,
 *    see the wiring map in capability-policy.ts);
 *  - the TaintStore records which NAMED VALUES (keys: file paths, command
 *    strings, output ids) were produced by, or derived from, which origin,
 *    and propagates the MOST-DANGEROUS source when a value is combined.
 *
 * Dangerousness ordering is fixed and forced-bottom-up (user < native <
 * read_file < tool_output < prose_tool < bare_json < orchestrator <
 * directive < repair): "directive" (a prompt-injected instruction talked the
 * model into the call) is worse than "bare_json" (a sloppy but autonomous
 * parse), and "repair" — the lane that runs with the most permission and the
 * least context — is the most dangerous. Anything derived from a mix of
 * origins inherits the worst, never the best: taint only ever RISES.
 *
 * Pure/in-memory: no I/O, no wall clock, JSON-serialisable so a task can carry
 * its store across a reload. Enforcement lives in capability-policy.ts, behind
 * the RELIABILITY_TAINT flag (flags.ts) — this file never blocks anything.
 */

export type Provenance =
  | "user"
  | "native"
  | "read_file"
  | "tool_output"
  | "prose_tool"
  | "bare_json"
  | "orchestrator"
  | "directive"
  | "repair";

/**
 * The fixed dangerousness ladder, index = danger (higher = more dangerous).
 * Single source of truth for MOST_DANGEROUS and for TaintStore.propagate.
 */
export const PROVENANCE_DANGEROUSNESS: readonly Provenance[] = [
  "user",
  "native",
  "read_file",
  "tool_output",
  "prose_tool",
  "bare_json",
  "orchestrator",
  "directive",
  "repair",
];

/** The most dangerous provenance on the ladder. */
export const MOST_DANGEROUS: Provenance = "repair";

function danger(prov: Provenance): number {
  const idx = PROVENANCE_DANGEROUSNESS.indexOf(prov);
  return idx === -1 ? -1 : idx;
}

/**
 * The MOST-DANGEROUS provenance out of a set (by the ladder above). Returns
 * null for an empty input. This is the only merge rule: taint never averages,
 * and never chooses the read's label over the parse's label.
 */
export function mostDangerous(provs: readonly Provenance[]): Provenance | null {
  let worst: Provenance | null = null;
  let worstRank = -1;
  for (const p of provs) {
    const rank = danger(p);
    if (rank > worstRank) {
      worstRank = rank;
      worst = p;
    }
  }
  return worst;
}

/**
 * True when the provenance is a USER-typed value — the trusted case.
 * Everything the model or a tool produced is suspect by definition.
 */
export function isUserProvenance(prov: Provenance): boolean {
  return prov === "user";
}

/**
 * A taint ledger: named keys (file paths, command strings, output ids) mapped
 * to the provenance they were produced by. mark/propagate only ever RAISE the
 * danger of an entry — nothing can de-taint a path after it was touched by
 * risky provenance, short of clear() for a whole fresh task.
 */
export class TaintStore {
  private entries = new Map<string, Provenance>();

  /**
   * Record that `key` was produced by `prov`. Monotonic: marking an already
   * recorded key keeps the MORE dangerous of the two labels (taint rises,
   * never falls), so an orchestrator-tainted path is not laundered by a later
   * user mark with the same key.
   */
  mark(key: string, prov: Provenance): this {
    if (!key || !PROVENANCE_DANGEROUSNESS.includes(prov)) {
      return this;
    }
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, prov);
    } else {
      const worst = mostDangerous([existing, prov]);
      if (worst !== null) this.entries.set(key, worst);
    }
    return this;
  }

  /** The stored provenance for `key`, or null when the key is unknown. */
  get(key: string): Provenance | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * True when `key` is known AND non-user (carries taint worth checking).
   * A "user" entry records where the value came from without treating it as
   * suspect — propagation still accounts for it, isTainted does not flag it.
   */
  isTainted(key: string): boolean {
    const prov = this.entries.get(key);
    return prov !== undefined && prov !== "user";
  }

  /**
   * Record that `destKey` was derived from `srcKeys`: it inherits the
   * MOST-DANGEROUS provenance of the sources that have entries. Sources with
   * no entry are ignored (they are still being typed / not yet observed);
   * when no source has an entry, the destination stays unrecorded.
   * Destinations already carrying a more dangerous label are not lowered.
   */
  propagate(destKey: string, srcKeys: readonly string[]): Provenance | null {
    if (!destKey) return null;
    const srcs: Provenance[] = [];
    for (const src of srcKeys) {
      const prov = this.entries.get(src);
      if (prov !== undefined) srcs.push(prov);
    }
    if (srcs.length === 0) return null;
    const inherited = mostDangerous(srcs);
    if (inherited === null) return null;
    this.mark(destKey, inherited);
    return inherited;
  }

  /** Drop every entry. Per-task scope: call between tasks, never mid-loop. */
  clear(): void {
    this.entries.clear();
  }

  /** Snapshot for persistence / the eval harness. */
  toJSON(): Record<string, Provenance> {
    const out: Record<string, Provenance> = {};
    for (const [key, prov] of this.entries) out[key] = prov;
    return out;
  }

  /**
   * Rebuild from toJSON() output (object) or its JSON string form. Unknown
   * provenance strings are DROPPED rather than guessed — an unlabelled key is
   * safer than one carrying an invented label.
   */
  static fromJSON(json: string | Record<string, Provenance> | null | undefined): TaintStore {
    const store = new TaintStore();
    if (!json) return store;
    let raw: Record<string, unknown>;
    if (typeof json === "string") {
      try {
        raw = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return store;
      }
    } else {
      raw = json;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) return store;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && PROVENANCE_DANGEROUSNESS.includes(value as Provenance)) {
        store.entries.set(key, value as Provenance);
      }
    }
    return store;
  }
}
