// catalog-sync.ts — Autonomous BYOK catalogue maintenance.
//
// The model-listing engine can fetch a provider's entire catalogue, but a
// capability nobody triggers is a capability the user never sees. Keys used to
// sit with an EMPTY modelsCache until the user manually pasted a key and
// clicked "Fetch models" — so the picker showed almost nothing for every key
// added after the first one.
//
// This module makes the catalogue self-maintaining, with no user action and no
// blocking request ever:
//
//   syncKeyCatalog()      fetch + persist one key's catalogue (idempotent)
//   ensureCatalogsFresh() top up every STALE key for a user, cheaply
//
// Rules that keep it safe to call on any request path:
//   - never throws (all failures are swallowed and logged by caller),
//   - never blocks the HTTP response — callers either await it explicitly
//     (the add-key flow) or hand it to Next's `after()`,
//   - keys are decrypted in memory only and are never returned or logged,
//   - a stale window keeps this from re-hammering providers every request.

import { prisma } from "./prisma";
import { decryptKey } from "./key-encryption";
import { getProviderDef } from "./provider-registry";
import { listProviderModels } from "./provider-models";

/**
 * How old a cached catalogue may get before we quietly refresh it.
 *
 * Model catalogues churn constantly (new free models appear daily, paid ones
 * get retired), so this is measured in hours rather than days — but it is still
 * long enough that normal usage never re-fetches.
 */
export const CATALOG_STALE_MS = 6 * 60 * 60 * 1000;

export interface SyncResult {
  synced: boolean;
  count?: number;
  listedTotal?: number;
  truncated?: boolean;
  /** Present when the attempt ran but did not produce a usable catalogue. */
  error?: string;
}

/**
 * Fetch and persist the full catalogue for ONE stored key.
 *
 * Ownership is enforced by construction: the row is looked up by
 * `{ id, userId }`, so a caller can never write a catalogue onto someone
 * else's key no matter what ids it passes.
 */
export async function syncKeyCatalog(userId: string, keyId: string): Promise<SyncResult> {
  try {
    const stored = await prisma.userApiKey.findFirst({
      where: { id: keyId, userId },
      select: { id: true, provider: true, apiKey: true },
    });
    if (!stored) return { synced: false, error: "Key not found." };
    // Same reasoning as the listing-failure path below: a provider that is no
    // longer in the registry (or a key that can't be decrypted) must not stay
    // "due" forever and be retried on every single picker poll.
    if (!getProviderDef(stored.provider)) {
      await prisma.userApiKey
        .updateMany({ where: { id: stored.id, userId }, data: { modelsFetchedAt: new Date() } })
        .catch(() => {});
      return { synced: false, error: "Unknown provider." };
    }

    let apiKey = "";
    try {
      apiKey = decryptKey(stored.apiKey);
    } catch {
      // A key we cannot decrypt (e.g. ENCRYPTION_SECRET rotated) is a real
      // problem, but it must not surface as a crash in someone else's request.
      return { synced: false, error: "Stored key unreadable." };
    }
    if (!apiKey) return { synced: false, error: "Stored key unreadable." };

    const listing = await listProviderModels(stored.provider, apiKey);
    if (!listing.ok || listing.models.length === 0) {
      // Stamp the attempt even on failure. Without this, `modelsFetchedAt`
      // stayed null, `ensureCatalogsFresh` treated the key as permanently
      // "due", and because /api/models/available runs it via after() on EVERY
      // picker poll — and the client polls every 5s while the catalog is cold
      // — a key whose provider was down (or had been removed from the
      // registry entirely) was retried ~120 times per 10 minutes, forever.
      await prisma.userApiKey
        .updateMany({ where: { id: stored.id, userId }, data: { modelsFetchedAt: new Date() } })
        .catch(() => {});
      return { synced: false, error: listing.error ?? "No chat models found." };
    }

    await prisma.userApiKey.updateMany({
      where: { id: stored.id, userId },
      data: { modelsCache: listing.models as unknown as object, modelsFetchedAt: new Date() },
    });

    return {
      synced: true,
      count: listing.models.length,
      listedTotal: listing.listedTotal ?? listing.models.length,
      truncated: listing.truncated === true,
    };
  } catch (err) {
    return { synced: false, error: err instanceof Error ? err.message : "Catalogue sync failed." };
  }
}

/**
 * Queue a refresh for any of this user's keys whose catalogue is missing or
 * stale. Returns the promises so a caller can await them when it genuinely
 * needs the data; otherwise fire-and-forget via `after()` is fine.
 *
 * Concurrency is deliberately small (3 at a time): enough to repair a cold
 * account quickly, not enough to look like a scraping run to the provider.
 */
export async function ensureCatalogsFresh(userId: string): Promise<SyncResult[]> {
  let due: Array<{ id: string }> = [];
  try {
    const cutoff = new Date(Date.now() - CATALOG_STALE_MS);
    due = await prisma.userApiKey.findMany({
      where: {
        userId,
        isActive: true,
        OR: [{ modelsFetchedAt: null }, { modelsFetchedAt: { lt: cutoff } }],
      },
      select: { id: true },
      take: 25,
    });
  } catch {
    return []; // DB hiccup must never break the page that triggered this
  }
  if (due.length === 0) return [];

  const out: SyncResult[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((k) => syncKeyCatalog(userId, k.id)));
    out.push(...settled);
  }
  return out;
}