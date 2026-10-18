/**
 * reliability/flake-control.ts — Phase 2. Flake classification, a bounded
 * rerun policy, and a JSON-serializable quarantine registry.
 *
 * Phase 0 finding (D-8 / AUDIT §2): there was no flake classifier at all, so a
 * single flaky failure burned a full MAX_REPAIR_ROUNDS trying to "fix" code
 * that was never broken. The registry records every (test, outcome) the gate
 * sees; a test that fails at least once and passes at least once within the
 * rerun budget is unstable and gets quarantined — annotated, not gating.
 *
 * Parsing is regex over real jest output (plain text summary or --json), no
 * new dependencies (D-5).
 */

/** Rerun budget: one original attempt + this many retries. */
export const FLAKE_MAX_RERUNS = 2;

export interface FlakeOutcome {
  flaky: boolean;
  failures: number;
  passes: number;
}

export interface FlakeEntry {
  testPath: string;
  testName: string;
  failures: number;
  passes: number;
  at: number;
}

/** `Tests:       1 failed, 12 passed, 13 total` — the jest text summary line. */
const TESTS_SUMMARY_RE = /Tests:\s*(?:(\d+)\s*failed,?\s*)?(?:(\d+)\s*passed,?\s*)?(?:(\d+)\s*skipped,?\s*)?(\d+)\s*total/i;

/** Per-test result lines: `✓ name (2 ms)` / `✕ name (2 ms)` (also ✗/×/✔). */
const TEST_LINE_RE = /^\s*([✓✔✕✗×])\s+(.+?)(?:\s*\(\d[\d.]*\s*m?s\))?\s*$/gm;

function parseTextAttempts(raw: string): Array<{ failures: number; passes: number }> {
  const attempts: Array<{ failures: number; passes: number }> = [];
  const re = new RegExp(TESTS_SUMMARY_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attempts.push({
      failures: m[1] ? parseInt(m[1], 10) : 0,
      passes: m[2] ? parseInt(m[2], 10) : 0,
    });
  }
  return attempts;
}

function parseJsonAttempts(raw: string): Array<{ failures: number; passes: number }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const fromRun = (run: Record<string, unknown>): { failures: number; passes: number } => {
    if (typeof run.numFailedTests === "number" || typeof run.numPassedTests === "number") {
      return {
        failures: typeof run.numFailedTests === "number" ? run.numFailedTests : 0,
        passes: typeof run.numPassedTests === "number" ? run.numPassedTests : 0,
      };
    }
    let failures = 0;
    let passes = 0;
    const testResults = Array.isArray(run.testResults) ? run.testResults : [];
    for (const suite of testResults) {
      const assertions = suite && typeof suite === "object" && Array.isArray((suite as Record<string, unknown>).assertionResults)
        ? ((suite as Record<string, unknown>).assertionResults as Array<Record<string, unknown>>)
        : [];
      for (const a of assertions) {
        if (a.status === "failed") failures += 1;
        else if (a.status === "passed") passes += 1;
      }
    }
    return { failures, passes };
  };
  if (Array.isArray(parsed)) {
    return parsed
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map(fromRun);
  }
  if (typeof parsed === "object" && parsed !== null) {
    return [fromRun(parsed as Record<string, unknown>)];
  }
  return null;
}

/** Per-test pass/fail marks across the whole raw text, keyed by test name. */
function parseTestMarks(raw: string): Map<string, { pass: boolean; fail: boolean }> {
  const marks = new Map<string, { pass: boolean; fail: boolean }>();
  const re = new RegExp(TEST_LINE_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const passed = m[1] === "✓" || m[1] === "✔";
    const name = m[2].trim();
    if (!name) continue;
    const entry = marks.get(name) || { pass: false, fail: false };
    if (passed) entry.pass = true;
    else entry.fail = true;
    marks.set(name, entry);
  }
  return marks;
}

/**
 * Classify jest output that may aggregate the original attempt plus up to
 * `reruns` retries.
 *
 * - `failures`/`passes` are the LATEST attempt's totals (what the gate sees
 *   now); older attempts beyond the rerun budget are ignored.
 * - `flaky` is the pass-after-fail signature: some attempt failed and the
 *   latest passed, OR the same test name carries both a ✓ and a ✕ mark
 *   anywhere in the raw output. Unparseable input yields all-false/zero —
 *   callers must treat a zero-parse as "unknown", not as a green run.
 */
export function classifyTestOutcome(raw: string, reruns: number): FlakeOutcome {
  let attempts = parseJsonAttempts(raw);
  if (!attempts || attempts.length === 0) {
    attempts = parseTextAttempts(raw);
  }
  // Only the last (reruns + 1) attempts belong to this classification window.
  if (attempts.length > reruns + 1) {
    attempts = attempts.slice(-(reruns + 1));
  }
  const latest = attempts.length > 0 ? attempts[attempts.length - 1] : { failures: 0, passes: 0 };

  let flaky = false;
  for (const entry of parseTestMarks(raw).values()) {
    if (entry.pass && entry.fail) {
      flaky = true;
      break;
    }
  }
  if (!flaky) {
    const anyFailed = attempts.some(a => a.failures > 0);
    flaky = attempts.length > 1 && anyFailed && latest.failures === 0 && latest.passes > 0;
  }

  return { flaky, failures: latest.failures, passes: latest.passes };
}

/**
 * A failed test may be rerun while budget remains. Rerunning is what turns a
 * one-off failure into classifiable flake evidence instead of a burned repair
 * round.
 */
export function shouldRerun(failures: number, reruns: number, maxReruns: number): boolean {
  return failures > 0 && reruns < maxReruns;
}

interface FlakePathState {
  failures: number;
  passes: number;
  lastAt: number;
}

/** Persisted shape of the registry (see FlakeRegistry.toJSON). */
export interface FlakeRegistryJSON {
  version: 1;
  entries: FlakeEntry[];
}

/**
 * Durable record of per-test outcomes. Quarantine rule: a testPath that has
 * failed at least once AND passed at least once within the rerun budget is
 * unstable — it must not fail a gate or burn repair rounds.
 */
export class FlakeRegistry {
  private entries: FlakeEntry[] = [];
  private byPath = new Map<string, FlakePathState>();

  add(entry: FlakeEntry): void {
    this.entries.push({ ...entry });
    const state = this.byPath.get(entry.testPath) || { failures: 0, passes: 0, lastAt: 0 };
    state.failures += entry.failures;
    state.passes += entry.passes;
    state.lastAt = Math.max(state.lastAt, entry.at);
    this.byPath.set(entry.testPath, state);
  }

  /** Unstable = failed at least once and passed at least once. */
  isQuarantined(testPath: string): boolean {
    const state = this.byPath.get(testPath);
    if (!state) return false;
    return state.failures > 0 && state.passes > 0;
  }

  /** Cumulative counters for one path (undefined when never seen). */
  stats(testPath: string): Readonly<FlakePathState> | undefined {
    return this.byPath.get(testPath);
  }

  /** Every quarantined path, sorted for stable reporting. */
  quarantinedPaths(): string[] {
    return [...this.byPath.keys()].filter(p => this.isQuarantined(p)).sort();
  }

  get size(): number {
    return this.entries.length;
  }

  toJSON(): FlakeRegistryJSON {
    return { version: 1, entries: this.entries.map(e => ({ ...e })) };
  }

  /**
   * Rebuild from a JSON string or a parsed payload. Malformed entries are
   * skipped (a corrupt record must not take the whole registry down); a
   * payload without an entries array throws so the caller knows the file is
   * not a registry at all.
   */
  static fromJSON(data: unknown): FlakeRegistry {
    const payload: unknown = typeof data === "string" ? JSON.parse(data) : data;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !Array.isArray((payload as FlakeRegistryJSON).entries)
    ) {
      throw new Error("FlakeRegistry.fromJSON: payload must be an object with an entries array");
    }
    const registry = new FlakeRegistry();
    for (const entry of (payload as FlakeRegistryJSON).entries) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.testPath === "string" &&
        typeof entry.testName === "string" &&
        typeof entry.failures === "number" &&
        typeof entry.passes === "number" &&
        typeof entry.at === "number"
      ) {
        registry.add(entry);
      }
    }
    return registry;
  }
}
