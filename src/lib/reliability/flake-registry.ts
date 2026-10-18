/**
 * reliability/flake-registry.ts — Phase 6: a durable flake registry with an
 * injected storage interface, mirroring flake-control.ts's in-memory
 * FlakeRegistry across restarts.
 *
 * flake-control.ts classifies one run's jest output in memory; this registry
 * is the persistence layer around the same idea: per-(testPath, testName)
 * counters that survive a reload, plus the `quarantined` flag a gate consults
 * before letting a test fail a task. Entry shape extends flake-control's
 * FlakeEntry ({testPath, testName, failures, passes, at}) with firstSeen /
 * lastSeen / quarantined — `durableFlakeEntryFrom` adapts a flake-control
 * entry structurally (no import coupling).
 *
 * Behaviour gate: recording outcomes is unconditional (evidence collection),
 * but `isQuarantined` — the decision that changes what the gate does — runs
 * only under reliabilityDurableMemoryEnabled() (RELIABILITY_GATES=1 +
 * RELIABILITY_DURABLE_MEMORY=1). New gate-affecting behaviour defaults OFF.
 */

import { reliabilityDurableMemoryEnabled } from "./flags";

export interface FlakeEntry {
  testPath: string;
  testName: string;
  failures: number;
  passes: number;
  firstSeen: number;
  lastSeen: number;
  quarantined: boolean;
}

export interface FlakeStorage {
  get(key: string): Promise<FlakeEntry | null>;
  set(key: string, entry: FlakeEntry): Promise<void>;
  list(): Promise<FlakeEntry[]>;
}

/** Persisted snapshot shape (see DurableFlakeRegistry.toJSON). */
export interface DurableFlakeRegistryJSON {
  version: 1;
  entries: FlakeEntry[];
}

const MAX_PATH_CHARS = 300;
const MAX_NAME_CHARS = 500;

/** Storage key for one test. Same key the storage `get`/`set` use. */
export function flakeKey(testPath: string, testName: string): string {
  return `${String(testPath).slice(0, MAX_PATH_CHARS)} ${String(testName).slice(0, MAX_NAME_CHARS)}`;
}

function isFiniteTime(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clampCounter(n: unknown): number {
  return Math.min(Math.max(Math.floor(Number(n) || 0), 0), 1_000_000);
}

/** Defensive validation of an entry read back from durable storage. */
export function normalizeFlakeEntry(raw: unknown): FlakeEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<FlakeEntry>;
  if (typeof r.testPath !== "string" || !r.testPath) return null;
  if (typeof r.testName !== "string" || !r.testName) return null;
  const failures = clampCounter(r.failures);
  const passes = clampCounter(r.passes);
  const firstSeen = isFiniteTime(r.firstSeen) ? r.firstSeen : (isFiniteTime(r.lastSeen) ? r.lastSeen : Date.now());
  const lastSeen = isFiniteTime(r.lastSeen) ? r.lastSeen : firstSeen;
  return {
    testPath: r.testPath.slice(0, MAX_PATH_CHARS),
    testName: r.testName.slice(0, MAX_NAME_CHARS),
    failures,
    passes,
    firstSeen,
    lastSeen,
    // Recomputed from the counters, never trusted from storage: quarantine is
    // a rule, not a stored opinion that could drift away from the evidence.
    quarantined: r.quarantined === true && failures > 0 && passes > 0,
  };
}

/**
 * Adapt flake-control.ts's in-memory entry ({... , at}) to the durable shape.
 * Structural on purpose: no import of flake-control, so the two modules can
 * evolve independently.
 */
export function durableFlakeEntryFrom(input: {
  testPath: string;
  testName: string;
  failures: number;
  passes: number;
  at: number;
}): FlakeEntry {
  const at = isFiniteTime(input.at) ? input.at : Date.now();
  const failures = clampCounter(input.failures);
  const passes = clampCounter(input.passes);
  return {
    testPath: String(input.testPath).slice(0, MAX_PATH_CHARS),
    testName: String(input.testName).slice(0, MAX_NAME_CHARS),
    failures,
    passes,
    firstSeen: at,
    lastSeen: at,
    quarantined: failures > 0 && passes > 0,
  };
}

/**
 * Same rule flake-control.ts applies per path: a test that has failed at
 * least once AND passed at least once is unstable — quarantined, so it is
 * annotated instead of failing a gate or burning repair rounds.
 */
function computeQuarantined(failures: number, passes: number): boolean {
  return failures > 0 && passes > 0;
}

export class DurableFlakeRegistry {
  private readonly cache = new Map<string, FlakeEntry>();
  private loaded = false;
  private readonly now: () => number;

  constructor(
    private readonly storage: FlakeStorage,
    opts?: { now?: () => number }
  ) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Load every stored entry into the read-through cache. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const rows = await this.storage.list();
      if (!Array.isArray(rows)) return;
      for (const raw of rows) {
        const e = normalizeFlakeEntry(raw);
        if (e) this.cache.set(flakeKey(e.testPath, e.testName), e);
      }
    } catch {
      // Storage unreachable → the registry starts empty; recording still works.
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.hydrate();
  }

  /** One observed outcome. Updates counters and persists; never throws. */
  async recordOutcome(testPath: string, testName: string, passed: boolean): Promise<FlakeEntry | null> {
    const path = String(testPath || "").slice(0, MAX_PATH_CHARS);
    const name = String(testName || "").slice(0, MAX_NAME_CHARS);
    if (!path || !name) return null;
    await this.ensureLoaded();
    const key = flakeKey(path, name);
    const now = this.now();
    const prev = this.cache.get(key);
    const entry: FlakeEntry = {
      testPath: path,
      testName: name,
      failures: clampCounter(prev?.failures) + (passed ? 0 : 1),
      passes: clampCounter(prev?.passes) + (passed ? 1 : 0),
      firstSeen: prev ? Math.min(prev.firstSeen, now) : now,
      lastSeen: prev ? Math.max(prev.lastSeen, now) : now,
      quarantined: false,
    };
    entry.quarantined = computeQuarantined(entry.failures, entry.passes);
    this.cache.set(key, entry);
    try {
      await this.storage.set(key, entry);
    } catch {
      // Durable write failed — the in-memory answer for THIS run still holds.
    }
    return entry;
  }

  /**
   * Is this test quarantined? Returns false unless the durable-memory flag is
   * armed: quarantine changes what the gate does, and that defaults OFF.
   * With `testName` omitted, any quarantined test under the path counts.
   */
  async isQuarantined(testPath: string, testName?: string): Promise<boolean> {
    if (!reliabilityDurableMemoryEnabled()) return false;
    await this.ensureLoaded();
    if (typeof testName === "string" && testName) {
      return this.cache.get(flakeKey(testPath, testName))?.quarantined === true;
    }
    const path = String(testPath);
    for (const e of this.cache.values()) {
      if (e.testPath === path && e.quarantined) return true;
    }
    return false;
  }

  /** Stored counters for one test (null when never seen). */
  async get(testPath: string, testName: string): Promise<FlakeEntry | null> {
    await this.ensureLoaded();
    return this.cache.get(flakeKey(testPath, testName)) ?? null;
  }

  /** Snapshot of every loaded entry — await it; do not JSON.stringify the instance. */
  async toJSON(): Promise<DurableFlakeRegistryJSON> {
    await this.ensureLoaded();
    const entries = [...this.cache.values()].sort(
      (a, b) => b.lastSeen - a.lastSeen || a.testPath.localeCompare(b.testPath)
    );
    return { version: 1, entries: entries.map((e) => ({ ...e })) };
  }

  /**
   * Import a snapshot: rebuilds the registry AND writes the entries through
   * to storage (best-effort per entry) so the import is durable too.
   */
  static async fromJSON(
    data: string | DurableFlakeRegistryJSON,
    storage: FlakeStorage
  ): Promise<DurableFlakeRegistry> {
    let payload: unknown = data;
    if (typeof data === "string") {
      try {
        payload = JSON.parse(data);
      } catch {
        payload = null;
      }
    }
    const registry = new DurableFlakeRegistry(storage);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !Array.isArray((payload as DurableFlakeRegistryJSON).entries)
    ) {
      return registry; // corrupt snapshot → empty registry, never a throw
    }
    for (const raw of (payload as DurableFlakeRegistryJSON).entries) {
      const e = normalizeFlakeEntry(raw);
      if (!e) continue;
      registry.cache.set(flakeKey(e.testPath, e.testName), e);
      try {
        await storage.set(flakeKey(e.testPath, e.testName), e);
      } catch {
        /* best-effort write-through */
      }
    }
    registry.loaded = true;
    return registry;
  }
}

/** In-memory FlakeStorage — the test double (and a no-DB fallback). */
export class MemoryFlakeStorage implements FlakeStorage {
  private readonly map = new Map<string, FlakeEntry>();

  async get(key: string): Promise<FlakeEntry | null> {
    const e = this.map.get(key);
    return e ? { ...e } : null;
  }

  async set(key: string, entry: FlakeEntry): Promise<void> {
    this.map.set(key, { ...entry });
  }

  async list(): Promise<FlakeEntry[]> {
    return [...this.map.values()].map((e) => ({ ...e }));
  }

  /** Test/inspection helper. */
  size(): number {
    return this.map.size;
  }
}
