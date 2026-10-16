// Local (filesystem) attachment store for chat images.
//
// Images are deliberately NOT stored in Postgres. The Message model has no
// attachment column and needs none: the message body keeps only a reference,
// and the bytes live on the user's own disk under
// `<workspace>/.orplex/attachments/`, next to the other per-project `.orplex`
// state (plugins, skills, checkpoints, history).
//
// Content-addressed by SHA-256 of the decoded bytes, so re-attaching the same
// screenshot is a no-op instead of a duplicate file.
//
// Why a LOCAL route rather than a normal /api route: `src/proxy.ts` rewrites
// every /api/* request to the cloud backend when ORPLEX_API_URL is set, and
// that backend runs on Vercel, whose filesystem is ephemeral. Writing there
// would lose the image on the next cold start. /api/attachments is therefore
// registered in LOCAL_ONLY_API_ROUTES and always served by the local Next
// process (Electron standalone or dev).

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";

export const ATTACHMENTS_DIRNAME = join(".orplex", "attachments");

/** Mirrors the client-side MAX_IMAGE_SIZE in file-utils.ts. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/**
 * Archives get a larger ceiling than images (mirrors MAX_ARCHIVE_SIZE in
 * file-utils.ts) — a .zip is a container, so the useful payload is routinely
 * bigger than one screenshot.
 */
export const MAX_ARCHIVE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

/** Extensions we will persist. Anything else is rejected. */
const ALLOWED_EXT = new Set(Object.keys(MIME));

/** Ceiling for a given extension, so an archive gets the larger budget. */
export function maxBytesForExt(ext: string): number {
  return ext === ".zip" ? MAX_ARCHIVE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
}

export function attachmentsDir(workspaceCwd: string): string {
  return join(workspaceCwd, ATTACHMENTS_DIRNAME);
}

/**
 * Locate a stored attachment when the current workspace is not the one it was
 * uploaded in.
 *
 * The DB stores only `attachment:<sha>.png` with no workspace association,
 * while the bytes live under whichever folder was open at upload time. Close
 * that folder, or switch projects, and the current-workspace path 404s - so
 * every image in every historical thread became unreachable even though the
 * bytes were still on disk. The ref is deliberately workspace-agnostic, so
 * resolution has to be too.
 *
 * Order: current workspace (the common case), then the recorded absolute
 * workspace if the DB still knows it, then a bounded scan of known workspace
 * roots. Ids are digest-shaped hex validated by isValidAttachmentId before any
 * path is built, so nothing here can escape an attachments directory.
 */
export async function locateAttachment(
  roots: Array<string | null | undefined>,
  id: string,
  ext: string,
): Promise<{ dir: string; data: Buffer } | null> {
  if (!isValidAttachmentId(id) || !ALLOWED_EXT.has(ext)) return null;
  const { readFile: read } = await import("node:fs/promises");
  for (const root of roots) {
    if (!root) continue;
    const dir = attachmentsDir(root);
    const file = join(dir, `${id}${ext}`);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    // Refuse an implausible size rather than reading it into memory.
    if (st.size > maxBytesForExt(ext)) continue;
    return { dir, data: await read(file) };
  }
  return null;
}

export function mimeForPath(p: string): string {
  // `extname(".png")` is "" — a leading-dot name has no extension — and the
  // serve route passes a bare extension. Accept either a full filename or a
  // bare extension, so the Content-Type is never silently wrong.
  const ext = p.startsWith(".") ? p.toLowerCase() : extname(p).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

export interface ParsedDataUrl {
  bytes: Buffer;
  ext: string;
  mime: string;
}

/**
 * Parse a `data:<mime>;base64,<payload>` URL. Rejects anything that is not a
 * supported image type or that exceeds the size ceiling — checked on the
 * DECODED size, because base64 inflates by ~33% and a 13MB string is only a
 * 10MB image.
 */
export function parseImageDataUrl(dataUrl: string): ParsedDataUrl | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([\s\S]*)$/.exec(dataUrl.trim());
  if (!m) return null;

  const mime = m[1].toLowerCase();
  // Derive the extension from the MIME type, not from a client-supplied name.
  const ext = extFromMime(mime);
  if (!ext || !ALLOWED_EXT.has(ext)) return null;

  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) return null;
  if (bytes.length > maxBytesForExt(ext)) return null;

  return { bytes, ext, mime };
}

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    // Browsers and Windows both hand us zip blobs under one of these.
    // Deliberately NOT application/octet-stream: that would let any binary
    // masquerade as an archive.
    case "application/zip":
    case "application/x-zip-compressed":
      return ".zip";
    default:
      return null;
  }
}

/** Content-addressed id: 32 hex chars of the SHA-256 digest. */
export function attachmentId(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Ids are derived from a digest, so they are always lowercase hex. Validating
 * the shape before it ever touches the filesystem is what keeps a crafted id
 * (`../../etc/passwd`) from escaping the attachments directory.
 */
export function isValidAttachmentId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

export async function saveAttachment(
  workspaceCwd: string,
  parsed: ParsedDataUrl,
): Promise<{ id: string; filename: string; bytes: number }> {
  const id = attachmentId(parsed.bytes);
  const filename = `${id}${parsed.ext}`;
  const dir = attachmentsDir(workspaceCwd);
  await mkdir(dir, { recursive: true });

  const target = join(dir, filename);
  // Content-addressed: if it already exists, the bytes are identical by
  // construction, so skip the write.
  //
  // Write to a temp file and rename. A bare writeFile truncates in place, so a
  // crash/disk-full/reader mid-write left a PARTIAL file that still passed
  // readAttachment's `isFile()` + size checks and was then served with
  // `Cache-Control: immutable` - permanently poisoned in the browser. Worse,
  // saveAttachment would never repair it: `existing.isFile()` is true, so the
  // write is skipped forever, and the id is content-addressed so it stays the
  // same. rename() within a directory is atomic, so a reader sees either the
  // old file or the complete new one.
  const existing = await stat(target).catch(() => null);
  if (!existing?.isFile()) {
    const { rename } = await import("node:fs/promises");
    const tmp = join(dir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, parsed.bytes);
      await rename(tmp, target);
    } catch (e) {
      // Never leave a .tmp behind, and never leave a partial file at `target`.
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  return { id, filename, bytes: parsed.bytes.length };
}

export async function readAttachment(
  workspaceCwd: string,
  id: string,
  ext: string,
): Promise<Buffer | null> {
  if (!isValidAttachmentId(id) || !ALLOWED_EXT.has(ext)) return null;
  const full = join(attachmentsDir(workspaceCwd), `${id}${ext}`);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile() || st.size > maxBytesForExt(ext)) return null;
  return readFile(full);
}

/** Build the stable reference stored in the message body. */
export function attachmentRef(id: string, ext: string): string {
  return `attachment:${id}${ext}`;
}

/** Parse a reference produced by attachmentRef. Returns null when malformed. */
export function parseAttachmentRef(
  ref: string,
): { id: string; ext: string } | null {
  const m = /^attachment:([a-f0-9]{32})(\.[a-z0-9]{2,5})$/.exec(ref.trim());
  if (!m) return null;
  if (!ALLOWED_EXT.has(m[2])) return null;
  return { id: m[1], ext: m[2] };
}

/** URL the client uses to render a stored attachment. */
export function attachmentUrl(id: string, ext: string): string {
  return `/api/attachments/${id}${ext}`;
}
