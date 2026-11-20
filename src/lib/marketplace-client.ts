// marketplace-client.ts — the app's one door to the Orplex marketplace.
//
// Everything the app used to hardcode (101 skills, 100 MCP servers, 40 plugin
// bundles) is published as signed data at
// https://github.com/Migratedboy/orplex-marketplace. This module fetches it,
// refuses anything whose Ed25519 signature does not verify, and caches the
// verified result on disk so an offline start still has a toolbox.
//
// Two rules that matter:
//   1. Never return an unverified catalog. A marketplace that can be edited
//      between the signature and the user is a prompt-injection channel.
//   2. Never block the app. A slow or missing marketplace degrades to the last
//      verified cache; a missing cache degrades to an empty catalog with a
//      reason, not an exception.
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { DEFAULT_INDEX_URL, verifyIndex } from "@orplex/sdk/marketplace";
import type { MarketplaceIndex } from "@orplex/sdk/marketplace";
import type { Skill, SkillCategory } from "@orplex/sdk/skills";
// Narrow subpath only: the /mcp and /plugins barrels pull Node transports
// (child_process) and must never reach a client bundle — this module is
// imported by background-worker, which a client component imports. For the same
// reason materialization lives in marketplace-bundles.ts (server-only).
import { applyOAuthEnvOverrides, type McpCatalogEntry } from "@orplex/sdk/lib/mcp-catalog";
import type { BundleDef } from "@orplex/sdk/lib/plugin-library/types";

/** Public key of the marketplace signing key (base64url SPKI DER). Public by design. */
export const MARKETPLACE_PUBLIC_KEY =
  process.env.ORPLEX_MARKETPLACE_PUBLIC_KEY ||
  "MCowBQYDK2VwAyEAHkhVgrVo_BE2BaOd580A-8unt2G3qPMjYXlhvxY4AfU";

export interface MarketplaceBundle {
  schemaVersion: number;
  generatedAt: string;
  counts: { skill: number; mcp: number; plugin: number };
  skillCategories: Array<{ id: string; name: string; icon: string }>;
  mcpCategories: Array<{ key: string; label: string }>;
  skills: Skill[];
  mcp: McpCatalogEntry[];
  plugins: Array<BundleDef & { name?: string }>;
}

export interface MarketplaceSnapshot {
  bundle: MarketplaceBundle | null;
  /** Where the data came from — surfaced in Settings so staleness is visible. */
  source: "network" | "cache" | "none";
  verified: boolean;
  fetchedAt: number | null;
  error?: string;
}

const TTL_MS = 12 * 60 * 60 * 1000; // 12h — long enough to not hammer GitHub, short enough to notice a bad publish
const FETCH_TIMEOUT_MS = 8000;

function indexUrl(): string {
  return process.env.ORPLEX_MARKETPLACE_URL || DEFAULT_INDEX_URL;
}

/** bundle.json sits next to index.json in the same published folder. */
function bundleUrl(): string {
  return indexUrl().replace(/index\.json$/, "bundle.json");
}

function cacheDir(): string {
  return process.env.ORPLEX_MARKETPLACE_CACHE || path.join(homedir(), ".orplex", "marketplace");
}

async function readCache(file: string): Promise<MarketplaceBundle | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir(), file), "utf8");
    return JSON.parse(raw) as MarketplaceBundle;
  } catch {
    return null;
  }
}

async function writeCache(file: string, bundle: MarketplaceBundle): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(path.join(cacheDir(), file), JSON.stringify(bundle), "utf8");
  } catch {
    /* caching is best-effort — a read-only profile still works, just slower */
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify then cache. The signature covers every field except `signature`
 * itself, so a tampered skill body or MCP url invalidates the whole bundle.
 */
async function loadFromNetwork(): Promise<MarketplaceSnapshot> {
  try {
    const raw = (await fetchJson(bundleUrl())) as MarketplaceBundle & { signature?: string | null };
    if (!raw || !Array.isArray(raw.skills) || !Array.isArray(raw.mcp)) {
      return { bundle: null, source: "none", verified: false, fetchedAt: null, error: "bundle malformed" };
    }
    if (!verifyIndex(raw as unknown as MarketplaceIndex, MARKETPLACE_PUBLIC_KEY)) {
      return { bundle: null, source: "none", verified: false, fetchedAt: null, error: "signature rejected" };
    }
    const { signature: _sig, ...payload } = raw;
    const bundle = payload as unknown as MarketplaceBundle;
    await writeCache("bundle.json", bundle);
    return { bundle, source: "network", verified: true, fetchedAt: Date.now() };
  } catch (err) {
    return {
      bundle: null,
      source: "none",
      verified: false,
      fetchedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let memo: Promise<MarketplaceSnapshot> | null = null;

// ---------------------------------------------------------------------------
// Synchronous mirrors.
//
// Connection and auth code decides whether a server id is "known" inside paths
// that cannot await. The verified bundle is mirrored into these arrays as soon
// as it loads, and an empty array before that is a safe answer: lookups return
// null, which callers already handle as "no catalogue hints for this id".
// ---------------------------------------------------------------------------
let syncMcp: readonly McpCatalogEntry[] = [];

/** MCP catalogue as currently loaded (possibly empty before the first load). */
export function peekMcpCatalog(): readonly McpCatalogEntry[] {
  return syncMcp;
}

function mirror(bundle: MarketplaceBundle | null): void {
  syncMcp = bundle ? applyOAuthEnvOverrides(bundle.mcp ?? []) : [];
}

async function load(): Promise<MarketplaceSnapshot> {
  const cached = await readCache("bundle.json");
  const meta = await readCache("meta.json").catch(() => null);
  const cachedAt = (meta as unknown as { fetchedAt?: number } | null)?.fetchedAt ?? 0;

  if (cached && Date.now() - cachedAt < TTL_MS) {
    mirror(cached);
    return { bundle: cached, source: "cache", verified: true, fetchedAt: cachedAt };
  }

  const fresh = await loadFromNetwork();
  if (fresh.bundle) {
    await writeCache("meta.json", { fetchedAt: fresh.fetchedAt } as unknown as MarketplaceBundle);
    mirror(fresh.bundle);
    return fresh;
  }
  // Network failed or the signature did not verify — serve the last verified
  // cache and report why, rather than showing an empty toolbox with no reason.
  if (cached) {
    mirror(cached);
    return { bundle: cached, source: "cache", verified: true, fetchedAt: cachedAt, error: fresh.error };
  }
  return fresh;
}

/** Memoized snapshot. Safe to await from routes, workers and pages. */
export function getMarketplaceSnapshot(): Promise<MarketplaceSnapshot> {
  if (!memo) memo = load();
  return memo;
}

/** Force the next call to re-fetch (Settings → "Refresh catalogue"). */
export function invalidateMarketplace(): void {
  memo = null;
}

/** Skills grouped exactly like the old hardcoded catalogue, or [] when offline. */
export async function getSkillCategories(): Promise<SkillCategory[]> {
  const { bundle } = await getMarketplaceSnapshot();
  if (!bundle) return [];
  const groups = new Map<string, SkillCategory>();
  for (const cat of bundle.skillCategories || []) {
    groups.set(cat.id, { id: cat.id, name: cat.name, icon: cat.icon, skills: [] });
  }
  for (const skill of bundle.skills || []) {
    let group = groups.get(skill.category);
    if (!group) {
      group = { id: skill.category, name: skill.category, icon: "✨", skills: [] };
      groups.set(skill.category, group);
    }
    group.skills.push(skill);
  }
  return [...groups.values()].filter((g) => g.skills.length > 0);
}

/** Flat skill list — the roster the agent is told about. */
export async function getAllSkills(): Promise<Skill[]> {
  const { bundle } = await getMarketplaceSnapshot();
  return bundle?.skills ?? [];
}

/** MCP catalogue, marketplace-owned, with operator OAuth overrides applied. */
export async function getMcpCatalog(): Promise<McpCatalogEntry[]> {
  await getMarketplaceSnapshot();
  return [...syncMcp];
}

/** Raw plugin bundle definitions as published (declarative data only). */
export async function getPluginBundles(): Promise<Array<BundleDef & { name?: string }>> {
  const { bundle } = await getMarketplaceSnapshot();
  return bundle?.plugins ?? [];
}

/**
// NOTE: no getMaterializedBundles here. Bundles are materialized in
// marketplace-bundles.ts, which is server-only (it pulls filesystem code).

/**
 * Test seam: install a catalogue without a network load. Production code never
 * calls this — the catalogue arrives through getMarketplaceSnapshot(). It exists
 * so tests can exercise connection/auth paths that need catalogue hints.
 */
export function __setMcpCatalogForTests(entries: readonly McpCatalogEntry[]): void {
  syncMcp = applyOAuthEnvOverrides(entries);
}
