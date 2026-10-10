// sync-transport.ts — Peer sync for checkpoints + file history.
//
// A "peer" is one Orplex install (a machine). Sync moves two things:
//   1. checkpoint refs (namespaced git refs, see checkpoint-sync.ts)
//   2. server-side file-history entries (.orplex/history.jsonl)
// Bundles are gzip-compressed JSON posted to a deployed hub (any Orplex
// server with ORPLEX_SYNC_HUB_SECRET set); pulls are cursor-based so a peer
// only downloads what it hasn't seen. RAM-safe: transfers are capped and
// streamed to disk before parse. Pulls happen on window focus only (the
// client gates visibility; this module stays pure).

import { createHash, createHmac } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const SYNC_WIRE_VERSION = 1;
export const MAX_SYNC_BUNDLE_BYTES = 25 * 1024 * 1024; // RAM guard (decompressed)
export const MAX_SYNC_COMPRESSED_BYTES = 5 * 1024 * 1024; // pre-decompression cap (gzip bomb guard)
export const MAX_SYNC_ENTRIES_PER_PULL = 500;

export interface HistoryEntryLike {
  id: string;
  at: string;
  [k: string]: unknown;
}

export interface SyncEnvelope {
  version: typeof SYNC_WIRE_VERSION;
  machineId: string;
  cursor: string; // highest entry id this peer already has (monotonic)
  entries: HistoryEntryLike[];
}

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || "");
  return a.length === b.length && createHash("sha256").update(a).digest().equals(createHash("sha256").update(b).digest());
}

/** Encode an envelope for the wire: gzip(json). */
export function encodeEnvelope(env: SyncEnvelope): Buffer {
  const json = JSON.stringify(env);
  if (Buffer.byteLength(json) > MAX_SYNC_BUNDLE_BYTES) {
    throw new Error(`sync bundle too large: ${json.length} bytes`);
  }
  return gzipSync(Buffer.from(json, "utf8"));
}

export function decodeEnvelope(raw: Buffer): SyncEnvelope {
  // Pre-decompression cap: reject gzip bombs before inflating into memory.
  if (raw.length > MAX_SYNC_COMPRESSED_BYTES) {
    throw new Error("sync bundle too large (compressed)");
  }
  const json = gunzipSync(raw).toString("utf8");
  if (Buffer.byteLength(json) > MAX_SYNC_BUNDLE_BYTES) {
    throw new Error("sync bundle too large");
  }
  const env = JSON.parse(json) as SyncEnvelope;
  if (env.version !== SYNC_WIRE_VERSION) {
    throw new Error(`unsupported sync wire version: ${env.version}`);
  }
  return env;
}

// === Cursor persistence (per peer id, in .orplex/) ===

export async function readSyncCursor(orplexDir: string): Promise<string> {
  try {
    const raw = await readFile(join(orplexDir, "sync-cursor.txt"), "utf8");
    return raw.trim();
  } catch {
    return "";
  }
}

export async function writeSyncCursor(orplexDir: string, cursor: string): Promise<void> {
  await mkdir(orplexDir, { recursive: true });
  await writeFile(join(orplexDir, "sync-cursor.txt"), cursor, "utf8");
}

// === Hub client ===

export interface SyncHubClientOptions {
  hubUrl: string; // e.g. https://api.example.com
  secret: string; // ORPLEX_SYNC_HUB_SECRET (same value on hub + peers)
  machineId: string;
  fetchImpl?: typeof fetch;
}

export interface PushResult {
  ok: boolean;
  accepted?: number;
  error?: string;
}

export interface PullResult {
  ok: boolean;
  entries: HistoryEntryLike[];
  nextCursor: string;
  error?: string;
}

export async function pushToHub(
  opts: SyncHubClientOptions,
  orplexDir: string,
  entries: HistoryEntryLike[]
): Promise<PushResult> {
  try {
    const cursor = await readSyncCursor(orplexDir);
    const env: SyncEnvelope = {
      version: SYNC_WIRE_VERSION,
      machineId: opts.machineId,
      cursor,
      entries: entries.slice(0, MAX_SYNC_ENTRIES_PER_PULL),
    };
    const body = encodeEnvelope(env);
    const res = await (opts.fetchImpl || fetch)(`${opts.hubUrl.replace(/\/$/, "")}/api/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
        "X-Orplex-Sync-Signature": signPayload(body.toString("base64"), opts.secret),
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      return { ok: false, error: `hub rejected push: ${res.status}` };
    }
    const data = (await res.json()) as { accepted?: number };
    return { ok: true, accepted: data.accepted ?? 0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

export async function pullFromHub(opts: SyncHubClientOptions, orplexDir: string): Promise<PullResult> {
  try {
    const cursor = await readSyncCursor(orplexDir);
    const res = await (opts.fetchImpl || fetch)(
      `${opts.hubUrl.replace(/\/$/, "")}/api/sync/pull?machine=${encodeURIComponent(opts.machineId)}&cursor=${encodeURIComponent(cursor)}&limit=${MAX_SYNC_ENTRIES_PER_PULL}`,
      { headers: { "X-Orplex-Sync-Signature": signPayload(cursor, opts.secret) } }
    );
    if (!res.ok) {
      return { ok: false, entries: [], nextCursor: cursor, error: `hub pull failed: ${res.status}` };
    }
    const raw = Buffer.from(await res.arrayBuffer());
    const env = decodeEnvelope(raw);
    return { ok: true, entries: env.entries, nextCursor: env.cursor };
  } catch (err) {
    return { ok: false, entries: [], nextCursor: await readSyncCursor(orplexDir), error: (err as Error).message.slice(0, 200) };
  }
}

/**
 * Full pull cycle: fetch → decode → merge into the local jsonl (dedup by id)
 * → advance the cursor. Never overwrites local entries; foreign ids are
 * appended, local ids are skipped.
 */
export async function syncPullAndMerge(
  opts: SyncHubClientOptions,
  orplexDir: string,
  localEntries: HistoryEntryLike[]
): Promise<PullResult & { merged: number }> {
  const pull = await pullFromHub(opts, orplexDir);
  if (!pull.ok) return { ...pull, merged: 0 };

  const seen = new Set(localEntries.map((e) => e.id));
  const fresh = pull.entries.filter((e) => !seen.has(e.id));
  if (fresh.length > 0) {
    const merged = [...localEntries, ...fresh].slice(-5000); // cap the local file
    await writeFile(
      join(orplexDir, "history.jsonl"),
      merged.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
    await writeSyncCursor(orplexDir, pull.nextCursor);
  }
  return { ...pull, merged: fresh.length };
}
