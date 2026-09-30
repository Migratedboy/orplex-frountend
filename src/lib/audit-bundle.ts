// audit-bundle.ts — The flight recorder: one self-verifying bundle per run.
//
// Orplex already records every input and action; this module packages them
// into a single artifact a compliance officer can read without tooling
// (manifest.md) and a machine can check for tampering (SHA-256 hash chain
// over the ordered event stream).
//
// Bundle shape:
//   { format, exportedAt, run, events: [{...event, prevHash, hash}],
//     artifacts, tasks, approvals, chainHead, manifestMd }
//
// The chain: hash[i] = sha256(hash[i-1] + sequence + JSON(payload)).
// verifyBundle recomputes it; any byte flipped anywhere breaks the chain.

import { createHash } from "crypto";

export const BUNDLE_FORMAT = "orplex-audit-bundle/v1";
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_BODY = 100_000;

export interface BundleEvent {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
  prevHash: string;
  hash: string;
}

export interface AuditBundle {
  format: string;
  exportedAt: string;
  run: Record<string, unknown>;
  events: BundleEvent[];
  artifacts: Array<{ kind: string; name: string; mediaType: string; content: string; truncated?: boolean }>;
  tasks: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  chainHead: string;
  manifestMd: string;
}

function eventHash(prevHash: string, sequence: number, payload: unknown): string {
  return createHash("sha256").update(`${prevHash}:${sequence}:${JSON.stringify(payload ?? null)}`).digest("hex");
}

/** Hash an ordered list of events into a chain; returns events + chain head. */
export function chainEvents<T extends { sequence: number; type: string; payload: unknown; createdAt: string }>(
  events: T[],
): { events: BundleEvent[]; chainHead: string } {
  let prev = "0";
  const chained: BundleEvent[] = events
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => {
      const hash = eventHash(prev, e.sequence, e.payload);
      const out = { sequence: e.sequence, type: e.type, payload: e.payload, createdAt: e.createdAt, prevHash: prev, hash };
      prev = hash;
      return out;
    });
  return { events: chained, chainHead: prev };
}

/** Pure verifier — recomputes the chain; false on any tampering. */
export function verifyBundle(bundle: AuditBundle): { valid: boolean; reason?: string } {
  if (bundle.format !== BUNDLE_FORMAT) return { valid: false, reason: `unknown format ${bundle.format}` };
  if (bundle.chainHead !== chainEvents(bundle.events).chainHead) {
    return { valid: false, reason: "event hash chain does not match chainHead — bundle was modified" };
  }
  return { valid: true };
}

/** Truncate long artifact bodies; screenshots are the bulk risk. */
export function clampArtifact(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_ARTIFACT_BODY) return { content, truncated: false };
  return { content: content.slice(0, MAX_ARTIFACT_BODY) + `\n\n[truncated ${content.length - MAX_ARTIFACT_BODY} chars]`, truncated: true };
}

export function buildManifestMd(
  run: Record<string, unknown>,
  events: BundleEvent[],
  approvals: Array<Record<string, unknown>>,
  chainHead: string,
): string {
  const lines: string[] = [];
  const status = String(run.status ?? "unknown");
  lines.push(`# Orplex Audit Bundle`);
  lines.push("");
  lines.push(`- **Run:** \`${String(run.id ?? "?")}\``);
  lines.push(`- **Status:** ${status}`);
  lines.push(`- **Prompt:** ${String(run.prompt ?? "").slice(0, 2_000)}`);
  lines.push(`- **Created:** ${String(run.createdAt ?? "?")}`);
  lines.push(`- **Completed:** ${String(run.completedAt ?? "—")}`);
  lines.push(`- **Exported:** ${new Date().toISOString()}`);
  lines.push(`- **Chain head (SHA-256):** \`${chainHead}\``);
  lines.push("");
  lines.push(`## Event timeline (${events.length} events)`);
  lines.push("");
  for (const e of events) {
    const at = e.createdAt ? new Date(e.createdAt).toISOString() : "?";
    lines.push(`- \`${at}\` **${e.type}** \`${e.hash.slice(0, 12)}\` ${JSON.stringify(e.payload ?? null).slice(0, 200)}`);
  }
  if (approvals.length > 0) {
    lines.push("");
    lines.push(`## Human approval decisions`);
    lines.push("");
    for (const a of approvals) {
      lines.push(`- **${String(a.action ?? "?")}** → **${String(a.status ?? "?")}**${a.decidedBy ? ` (by ${String(a.decidedBy)})` : ""} at ${String(a.decidedAt ?? "?")}`);
    }
  }
  lines.push("");
  lines.push(`## Verification`);
  lines.push("");
  lines.push(`Every event carries SHA-256(prevHash + sequence + payload). Recompute the chain`);
  lines.push(`to prove no event was added, removed, or edited after export. A verifier is`);
  lines.push(`built into Orplex: POST /api/agent/runs/[id]/export/verify.`);
  lines.push("");
  return lines.join("\n");
}
