// catalog-ingest.ts — server-side store for rescue-published model catalogs.
//
// SERVERLESS RESCUE (ChatInput.tsx): the cloud backend can't run a probe
// sweep (no persistent caches, cold start replaced mid-sweep), so its
// /api/models/available answers empty. The long-lived local app sweeps for
// real, renders its own list, and PUBLISHES the snapshot here — so every
// later server-side cold start can serve a catalog again.
//
// Publishing is monotonic on probedAt: a once-published NEWER list must not
// be rolled back by some older client sweeping in the wrong order.
//
// Storage is a best-effort JSON file next to the server's cwd:
//  - desktop/self-host (long-lived process): works, like every other disk
//    cache in this app (.localpg, .model-catalog-cache.json).
//  - serverless: the filesystem is read-only, both the write and the read
//    fail soft and the feature degrades to today's behavior.

export interface IngestedCatalog {
  probedAt: string;
  providers: string[];
  models: Array<{ id: string; name: string; provider: string; contextWindow?: number; free?: boolean; cold?: boolean }>;
  throttledModels: Array<{ id: string; name: string; provider: string; contextWindow?: number; free?: boolean }>;
  providerIssues: Array<{ provider: string; kind: string; detail: string; count: number }>;
}

// Hard caps: the body is written to a file and later merged into a picker
// response — a hostile or buggy payload must never turn into an unbounded
// response or disk usage.
const MAX_MODELS = 500;
const MAX_THROTTLED = 200;
const MAX_ISSUES = 50;
const MAX_PROVIDERS = 20;
const MAX_STRING = 200;

const FILE_NAME = ".orplex-catalog-ingest.json";

type FsLibs = { fs: typeof import("fs"); path: typeof import("path") } | null;

function diskLibs(): FsLibs {
  if (typeof window !== "undefined") return null;
  try {
    // Same bundler-proof require access as model-catalog.ts's disk cache:
    // a plain `import("fs")` here drags the server module into edge/client
    // graphs, and a bare require breaks under webpack ESM.
    const req = eval("typeof require === 'function' ? require : null") as ((id: string) => unknown) | null;
    if (!req) return null;
    return { fs: req("fs") as typeof import("fs"), path: req("path") as typeof import("path") };
  } catch {
    return null;
  }
}

function filePath(libs: NonNullable<FsLibs>): string {
  return libs.path.join(process.cwd(), FILE_NAME);
}

function boundedText(v: unknown, max = MAX_STRING): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Softly coerce and cap exactly the fields the endpoint owns, or null when
 * the payload is unusable (wrong shape, zero models, garbage probedAt). */
export function validateIngestedCatalog(body: unknown): IngestedCatalog | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const probedAt = boundedText(b.probedAt, 64);
  if (!probedAt || Number.isNaN(Date.parse(probedAt))) return null;

  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const models = asArray(b.models)
    .slice(0, MAX_MODELS)
    .map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const id = boundedText(m.id, MAX_STRING);
      if (!id) return null;
      return {
        id,
        name: boundedText(m.name, MAX_STRING) ?? id,
        provider: boundedText(m.provider, MAX_STRING) ?? "unknown",
        contextWindow: typeof m.contextWindow === "number" && m.contextWindow > 0 ? Math.min(m.contextWindow, 10_000_000) : undefined,
        free: typeof m.free === "boolean" ? m.free : undefined,
        cold: typeof m.cold === "boolean" ? m.cold : undefined,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (models.length === 0) return null;

  const throttledModels = asArray(b.throttledModels)
    .slice(0, MAX_THROTTLED)
    .map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const id = boundedText(m.id, MAX_STRING);
      if (!id) return null;
      return {
        id,
        name: boundedText(m.name, MAX_STRING) ?? id,
        provider: boundedText(m.provider, MAX_STRING) ?? "unknown",
        contextWindow: typeof m.contextWindow === "number" && m.contextWindow > 0 ? Math.min(m.contextWindow, 10_000_000) : undefined,
        free: typeof m.free === "boolean" ? m.free : undefined,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const providerIssues = asArray(b.providerIssues)
    .slice(0, MAX_ISSUES)
    .map((raw) => {
      const issue = (raw ?? {}) as Record<string, unknown>;
      const provider = boundedText(issue.provider, MAX_STRING);
      if (!provider) return null;
      return {
        provider,
        kind: boundedText(issue.kind, MAX_STRING) ?? "unknown",
        detail: boundedText(issue.detail, 400) ?? "",
        count: typeof issue.count === "number" && issue.count >= 0 ? Math.min(Math.floor(issue.count), 10_000) : 1,
      };
    })
    .filter((i): i is NonNullable<typeof i> => i !== null);

  const providers = asArray(b.providers)
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .slice(0, MAX_PROVIDERS)
    .map((p) => p.trim().slice(0, MAX_STRING));

  return { probedAt, models, throttledModels, providerIssues, providers };
}

/**
 * Write the snapshot if, and only if, it is NEWER than anything already
 * stored. Monotonic on probedAt (see module doc) so Out-of-order publishing
 * can never make the catalog older.
 */
export function writeIngestedCatalog(body: unknown): { ok: boolean; replaced: boolean } {
  const next = validateIngestedCatalog(body);
  if (!next) return { ok: false, replaced: false };
  const libs = diskLibs();
  if (!libs) return { ok: false, replaced: false };
  try {
    const current = readIngestedCatalog();
    if (current && Date.parse(current.probedAt) > Date.parse(next.probedAt)) {
      // Older snapshot arriving late — keep the newer one on file.
      return { ok: true, replaced: false };
    }
    libs.fs.writeFileSync(filePath(libs), JSON.stringify(next), "utf8");
    return { ok: true, replaced: true };
  } catch {
    return { ok: false, replaced: false };
  }
}

/** Read the rescue-published snapshot, or null (missing / corrupt / expired). */
export function readIngestedCatalog(): IngestedCatalog | null {
  const libs = diskLibs();
  if (!libs) return null;
  try {
    const raw = libs.fs.readFileSync(filePath(libs), "utf8");
    // Write-side validation already capped everything; re-validate the read
    // anyway — the file also survives manual edits and old app versions.
    return validateIngestedCatalog(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Whether a published snapshot is fresher than a candidate probedAt. */
export function ingestedIsFresherThan(probedAtMs: number): boolean {
  const snap = readIngestedCatalog();
  if (!snap) return false;
  const snapMs = Date.parse(snap.probedAt);
  if (Number.isNaN(snapMs)) return false;
  return snapMs > probedAtMs;
}

/** Test hook: drop the stored snapshot. */
export function resetIngestedCatalogForTests(): void {
  const libs = diskLibs();
  if (!libs) return;
  try {
    libs.fs.unlinkSync(filePath(libs));
  } catch {
    /* nothing stored */
  }
}
