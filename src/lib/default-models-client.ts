import type { DefaultModelRow } from "./default-models";
import { apiFetch } from "./api-base";

export const MODEL_CATALOG_FILE = "modelcatalog.json";
export const LS_KEY = "orplex.modelcatalog";
export const DEFAULTS_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedDefaults {
  models: DefaultModelRow[];
  optIn: DefaultModelRow[];
  fetchedAt: string;
}

type FsLibs = { fs: typeof import("fs"); path: typeof import("path") } | null;

function diskLibs(): FsLibs {
  if (typeof window === "undefined") return null;
  try {
    const req = eval("typeof require === 'function' ? require : null") as ((id: string) => unknown) | null;
    if (!req) return null;
    return { fs: req("fs") as typeof import("fs"), path: req("path") as typeof import("path") };
  } catch {
    return null;
  }
}

function filePath(libs: NonNullable<FsLibs>): string {
  return libs.path.join(process.cwd(), MODEL_CATALOG_FILE);
}

/** Synchronous read of the cached defaults. Returns null when missing or stale. */
export function readCachedDefaultsSync(): CachedDefaults | null {
  // Disk first (desktop/Node process).
  const libs = diskLibs();
  if (libs) {
    try {
      const raw = libs.fs.readFileSync(filePath(libs), "utf8");
      const parsed = JSON.parse(raw) as CachedDefaults;
      if (!parsed || typeof parsed.fetchedAt !== "string") throw new Error("bad shape");
      if (Date.now() - new Date(parsed.fetchedAt).getTime() > DEFAULTS_TTL_MS) {
        // Expired: delete so the next fetch starts clean (no stale verdict).
        try { libs.fs.unlinkSync(filePath(libs)); } catch {}
        // fall through to localStorage
      } else {
        return { models: parsed.models ?? [], optIn: parsed.optIn ?? [], fetchedAt: parsed.fetchedAt };
      }
    } catch {
      // missing/corrupt — fall through
    }
  }
  // localStorage fallback (browser).
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedDefaults;
        if (parsed && typeof parsed.fetchedAt === "string" &&
            Date.now() - new Date(parsed.fetchedAt).getTime() <= DEFAULTS_TTL_MS) {
          return { models: parsed.models ?? [], optIn: parsed.optIn ?? [], fetchedAt: parsed.fetchedAt };
        }
        // stale or corrupt — remove
        window.localStorage.removeItem(LS_KEY);
      }
    } catch {
      try { window.localStorage.removeItem(LS_KEY); } catch {}
    }
  }
  return null;
}

/** Async alias for callers that prefer await. */
export async function readCachedDefaults(): Promise<CachedDefaults | null> {
  return readCachedDefaultsSync();
}

function writeCachedDefaults(data: CachedDefaults): void {
  const libs = diskLibs();
  if (libs) {
    try { libs.fs.writeFileSync(filePath(libs), JSON.stringify(data), "utf8"); } catch {}
  }
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
  }
}

function deleteCachedDefaults(): void {
  const libs = diskLibs();
  if (libs) {
    try { libs.fs.unlinkSync(filePath(libs)); } catch {}
  }
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(LS_KEY); } catch {}
  }
}

/**
 * Fetch the curated defaults from the backend and cache them. Deletes the
 * cache file/key FIRST so a stale verdict can never linger past its
 * validity window (mirrors readDiskCache in model-catalog.ts).
 */
export async function fetchAndCacheDefaults(): Promise<CachedDefaults | null> {
  deleteCachedDefaults();
  try {
    const res = await apiFetch("/api/models");
    if (!res.ok) return null;
    const json = (await res.json()) as { success?: boolean; models?: DefaultModelRow[]; optIn?: DefaultModelRow[]; fetchedAt?: string };
    if (!json || !Array.isArray(json.models)) return null;
    const data: CachedDefaults = {
      models: json.models ?? [],
      optIn: json.optIn ?? [],
      fetchedAt: json.fetchedAt ?? new Date().toISOString(),
    };
    writeCachedDefaults(data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Returns cached defaults if fresh (within 24h), otherwise fetches from the
 * backend and caches. On failure returns whatever cache exists (even stale)
 * or null. Never throws.
 */
export async function getDefaultModels(): Promise<CachedDefaults | null> {
  const cached = readCachedDefaultsSync();
  if (cached) return cached;
  const fetched = await fetchAndCacheDefaults();
  if (fetched) return fetched;
  // Last resort: try stale cache (ignore TTL) so offline still shows something.
  try {
    const libs = diskLibs();
    if (libs) {
      const raw = libs.fs.readFileSync(filePath(libs), "utf8");
      const parsed = JSON.parse(raw) as CachedDefaults;
      if (parsed && Array.isArray(parsed.models)) return { models: parsed.models ?? [], optIn: parsed.optIn ?? [], fetchedAt: parsed.fetchedAt ?? "" };
    }
  } catch {}
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedDefaults;
        if (parsed && Array.isArray(parsed.models)) return { models: parsed.models ?? [], optIn: parsed.optIn ?? [], fetchedAt: parsed.fetchedAt ?? "" };
      }
    } catch {}
  }
  return null;
}