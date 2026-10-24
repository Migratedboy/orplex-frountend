// artifact-sandbox.ts — shared validation for the [ARTIFACT] execution lanes.
//
// The browser parser (message-content.ts on the client) validates the same
// shape for rendering. This module re-validates INDEPENDENTLY on the server:
// these bodies come from user-run AI content, so every limit is enforced
// again server-side (never trust the client render path).

import type { SandboxFileSpec, SandboxLanguage } from "./vercel-sandbox";

export const ARTIFACT_MAX_FILES = 25;
export const ARTIFACT_MAX_FILE_CHARS = 80_000;
export const ARTIFACT_MAX_TOTAL_CHARS = 200_000;
export const ARTIFACT_ENTRY_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export interface ArtifactRunPayload {
  files: SandboxFileSpec[];
  entry: string;
  language: SandboxLanguage;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  artifact?: ArtifactRunPayload;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Characters that must never appear in a staged file path. */
const UNSAFE_PATH_CHARS = /[<>:"|?*]/;

/** Validate ONE file entry: content string within caps, relative safe path. */
function validateFile(raw: unknown, i: number): SandboxFileSpec | string {
  if (!isObject(raw)) return `files[${i}] must be an object`;
  // Artifacts name their files "name"; the sandbox lanes call them "path".
  // Accept both so a marker payload can be forwarded without reshaping.
  const rawPath =
    typeof raw.path === "string" ? raw.path : typeof raw.name === "string" ? raw.name : "";
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!rawPath) return `files[${i}].path required`;
  if (rawPath.includes("..") || rawPath.includes("\\") || rawPath.startsWith("/") || UNSAFE_PATH_CHARS.test(rawPath)) {
    return `files[${i}].path unsafe`;
  }
  if (content.length > ARTIFACT_MAX_FILE_CHARS) return `files[${i}] exceeds 80k chars`;
  return { path: rawPath, content };
}

/**
 * Validate the {files, entry, language} body for artifact-run / artifact-serve:
 * file count, per-file and total size caps, entry filename sanity, language.
 */
export function parseArtifactPayload(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, error: "body must be an object" };
  const language = body.language === "python" ? "python" : body.language === "node" ? "node" : null;
  if (!language) return { ok: false, error: `language must be "python" or "node"` };
  if (!Array.isArray(body.files)) return { ok: false, error: "files must be an array" };
  if (body.files.length === 0 || body.files.length > ARTIFACT_MAX_FILES) {
    return { ok: false, error: "files must contain 1-25 entries" };
  }
  const files: SandboxFileSpec[] = [];
  let total = 0;
  for (let i = 0; i < body.files.length; i++) {
    const one = validateFile(body.files[i], i);
    if (typeof one === "string") return { ok: false, error: one };
    total += one.content.length;
    files.push(one);
  }
  if (total > ARTIFACT_MAX_TOTAL_CHARS) return { ok: false, error: "total artifact exceeds 200k chars" };
  const entry = typeof body.entry === "string" ? body.entry : "";
  if (!ARTIFACT_ENTRY_RE.test(entry)) return { ok: false, error: "entry must be a bare filename" };
  if (!files.some((f) => f.path === entry)) return { ok: false, error: `entry "${entry}" not in files` };
  return { ok: true, artifact: { files, entry, language } };
}
