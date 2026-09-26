// storage-service.ts — Orplex-owned blob storage for sync payloads.
// Content-addressed chunks (sha2-256): dedup is free, integrity is verifiable,
// and the server never buffers a whole file — clients chunk, upload refs, and
// reassemble. Two drivers:
//   local (default) — .orplex/storage/chunks/<aa>/<hash>  (always available)
//   s3              — any S3-compatible endpoint (MinIO included) via the
//                     REST API with AWS SigV4 — zero dependencies.
// GC: chunks not referenced by any manifest past the grace window are deleted.

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";

export const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB — RAM-safe on 8GB machines
export const MAX_BLOB_BYTES = 64 * 1024 * 1024; // refuse >64MB blobs outright

export type StorageDriver = "local" | "s3";

export interface StorageConfig {
  driver: StorageDriver;
  /** Local driver: root dir. Default: .orplex/storage */
  localRoot?: string;
  /** S3 driver settings (from env ORPLEX_S3_*) */
  s3?: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
}

export function storageConfigFromEnv(): StorageConfig {
  const driver = (process.env.ORPLEX_STORAGE_DRIVER as StorageDriver) || "local";
  const cfg: StorageConfig = { driver, localRoot: process.env.ORPLEX_STORAGE_ROOT };
  if (driver === "s3") {
    const endpoint = process.env.ORPLEX_S3_ENDPOINT || "";
    const bucket = process.env.ORPLEX_S3_BUCKET || "";
    const accessKeyId = process.env.ORPLEX_S3_ACCESS_KEY_ID || "";
    const secretAccessKey = process.env.ORPLEX_S3_SECRET_ACCESS_KEY || "";
    if (endpoint && bucket && accessKeyId && secretAccessKey) {
      cfg.s3 = {
        endpoint,
        bucket,
        accessKeyId,
        secretAccessKey,
        region: process.env.ORPLEX_S3_REGION || "us-east-1",
      };
    }
  }
  return cfg;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Split a payload into deduped chunks. Returns refs, never stores. */
export function chunkBlob(data: Buffer): Array<{ hash: string; data: Buffer }> {
  const chunks: Array<{ hash: string; data: Buffer }> = [];
  for (let off = 0; off < data.length; off += CHUNK_SIZE) {
    const chunk = data.subarray(off, Math.min(off + CHUNK_SIZE, data.length));
    chunks.push({ hash: sha256(chunk), data: Buffer.from(chunk) });
  }
  if (chunks.length === 0) chunks.push({ hash: sha256(Buffer.alloc(0)), data: Buffer.alloc(0) });
  return chunks;
}

export interface BlobManifest {
  hash: string; // manifest hash = sha256(canonical json)
  size: number;
  chunks: string[]; // ordered chunk hashes
}

export function buildManifest(data: Buffer): BlobManifest {
  const chunks = chunkBlob(data).map((c) => c.hash);
  const manifest = { size: data.length, chunks };
  const hash = sha256(JSON.stringify(manifest));
  return { hash, size: data.length, chunks };
}

// === Local driver ===

function chunkPath(root: string, hash: string): string {
  return join(root, "chunks", hash.slice(0, 2), hash);
}

async function localPut(root: string, hash: string, data: Buffer): Promise<void> {
  const p = chunkPath(root, hash);
  await mkdir(join(p, ".."), { recursive: true });
  try {
    await writeFile(p, data, { flag: "wx" }); // dedup: already stored = no-op
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw e;
  }
}

async function localGet(root: string, hash: string): Promise<Buffer> {
  return readFile(chunkPath(root, hash));
}

async function localHas(root: string, hash: string): Promise<boolean> {
  try {
    await stat(chunkPath(root, hash));
    return true;
  } catch {
    return false;
  }
}

// === S3 driver (SigV4, zero deps) ===

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sigv4Headers(cfg: NonNullable<StorageConfig["s3"]>, method: string, key: string, body?: Buffer): Record<string, string> {
  const url = new URL(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? Buffer.alloc(0));

  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

async function s3Put(cfg: NonNullable<StorageConfig["s3"]>, key: string, data: Buffer): Promise<void> {
  const headers = sigv4Headers(cfg, "PUT", key, data);
  const res = await fetch(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key}`, {
    method: "PUT",
    headers,
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`s3 put failed: ${res.status}`);
}

async function s3Get(cfg: NonNullable<StorageConfig["s3"]>, key: string): Promise<Buffer> {
  const headers = sigv4Headers(cfg, "GET", key);
  const res = await fetch(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key}`, { headers });
  if (res.status === 404) throw new Error("ENOENT");
  if (!res.ok) throw new Error(`s3 get failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function s3Has(cfg: NonNullable<StorageConfig["s3"]>, key: string): Promise<boolean> {
  const url = new URL(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = sha256(Buffer.alloc(0));
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = ["HEAD", url.pathname, "", canonicalHeaders, "host;x-amz-content-sha256;x-amz-date", payloadHash].join("\n");
  const scope = `${amzDate.slice(0, 8)}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, amzDate.slice(0, 8));
  const kSigning = hmac(hmac(hmac(kDate, cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const res = await fetch(url.toString(), {
    method: "HEAD",
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
  return res.ok;
}

// === Driver-agnostic API ===

function s3Key(hash: string): string {
  return `chunks/${hash.slice(0, 2)}/${hash}`;
}

export class StorageService {
  constructor(private cfg: StorageConfig) {}

  async putChunk(hash: string, data: Buffer): Promise<void> {
    if (this.cfg.driver === "s3" && this.cfg.s3) return s3Put(this.cfg.s3, s3Key(hash), data);
    return localPut(this.cfg.localRoot || ".orplex/storage", hash, data);
  }

  async getChunk(hash: string): Promise<Buffer> {
    if (this.cfg.driver === "s3" && this.cfg.s3) return s3Get(this.cfg.s3, s3Key(hash));
    return localGet(this.cfg.localRoot || ".orplex/storage", hash);
  }

  async hasChunk(hash: string): Promise<boolean> {
    if (this.cfg.driver === "s3" && this.cfg.s3) return s3Has(this.cfg.s3, s3Key(hash));
    return localHas(this.cfg.localRoot || ".orplex/storage", hash);
  }

  /** Upload a whole blob: chunk, store missing chunks, return the manifest. */
  async putBlob(data: Buffer): Promise<BlobManifest> {
    if (data.length > MAX_BLOB_BYTES) {
      throw new Error(`blob too large: ${data.length} > ${MAX_BLOB_BYTES}`);
    }
    const manifest = buildManifest(data);
    const chunks = chunkBlob(data);
    for (const c of chunks) {
      if (!(await this.hasChunk(c.hash))) {
        await this.putChunk(c.hash, c.data);
      }
    }
    return manifest;
  }

  /** Reassemble a blob from its manifest, verifying every chunk hash. */
  async getBlob(manifest: BlobManifest): Promise<Buffer> {
    if (manifest.size > MAX_BLOB_BYTES) {
      throw new Error(`manifest too large: ${manifest.size}`);
    }
    const parts: Buffer[] = [];
    let total = 0;
    for (const hash of manifest.chunks) {
      const chunk = await this.getChunk(hash);
      if (sha256(chunk) !== hash) throw new Error(`chunk hash mismatch: ${hash.slice(0, 12)}`);
      parts.push(chunk);
      total += chunk.length;
    }
    if (total !== manifest.size) {
      throw new Error(`size mismatch: got ${total}, expected ${manifest.size}`);
    }
    return Buffer.concat(parts);
  }
}

/**
 * Garbage-collect unreferenced chunks older than the grace window.
 * `referencedHashes` = every chunk hash named by a live manifest.
 * RAM-safe: iterates the two-char prefix dirs with bounded listings.
 */
export async function gcStorage(
  root: string,
  referencedHashes: Set<string>,
  graceMs = 24 * 60 * 60 * 1000
): Promise<{ scanned: number; deleted: number; bytesFreed: number }> {
  const chunksRoot = join(root, "chunks");
  let scanned = 0;
  let deleted = 0;
  let bytesFreed = 0;

  let prefixes: string[] = [];
  try {
    prefixes = await readdir(chunksRoot);
  } catch {
    return { scanned, deleted, bytesFreed };
  }

  const cutoff = Date.now() - graceMs;
  for (const prefix of prefixes) {
    const dir = join(chunksRoot, prefix);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      scanned++;
      const hash = `${prefix}${name.slice(2)}`; // name IS the full hash actually
      void hash;
      if (referencedHashes.has(name)) continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.mtimeMs > cutoff) continue; // still inside the grace window
        bytesFreed += s.size;
        await unlink(full);
        deleted++;
      } catch {
        // raced or unreadable — next GC pass will catch it
      }
    }
    // prune empty prefix dirs
    try {
      const rest = await readdir(dir);
      if (rest.length === 0) await rm(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
  return { scanned, deleted, bytesFreed };
}
