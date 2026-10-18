/**
 * reliability/acceptance.ts — Phase 2, acceptance-first spec model. Before
 * this module the repo had only free-text todo_list/scratchpad entries: no
 * structured statement of "done", so a task could close with checks nobody
 * ever verified (baseline: unverified_checks = 10).
 *
 * The extraction is deterministic regex over the task text — checkboxes and
 * "must …" sentences — no LLM (D-5: no new dependencies; an acceptance spec
 * derived by another model call is an unverifiable artefact).
 */

import { z } from "zod";

export const acceptanceItemSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  verifiedBy: z.enum(["typecheck", "test", "browser", "manual", "none"]),
  evidence: z.string().optional(),
  status: z.enum(["unverified", "verified", "failed"]),
});

export type AcceptanceItem = z.infer<typeof acceptanceItemSchema>;

export const acceptanceSpecSchema = z.object({
  items: z.array(acceptanceItemSchema),
  source: z.enum(["user", "derived", "model"]),
});

export type AcceptanceSpec = z.infer<typeof acceptanceSpecSchema>;

export interface AcceptanceSummary {
  verified: number;
  failed: number;
  unverified: number;
  complete: boolean;
}

/** Markdown/GitHub checkbox lines: `- [ ] …`, `* [x] …`, `1. [X] …`. */
const CHECKBOX_RE = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]*\[[ xX]\][ \t]*(.+)/g;

/** Sentences containing "must" — the fallback requirement extractor. */
const MUST_SENTENCE_RE = /[^.!?\n]*\bmust\b[^.!?\n]*[.!?]?/gi;

/** FNV-1a — stable ids without a dependency or a random source. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Deterministic verifiedBy inference: an item that names its own verification
 * channel is recorded as such; anything else stays "none" so
 * summarizeAcceptance reports it as unverified until a human or the pipeline
 * fills it in.
 */
function inferVerifiedBy(statement: string): AcceptanceItem["verifiedBy"] {
  if (/\b(tsc|type[- ]?check(ing)?)\b/i.test(statement)) return "typecheck";
  if (/\b(jest|npm test|unit test(s)?|test suite)\b/i.test(statement)) return "test";
  if (/\b(browser|playwright|e2e|screenshot)\b/i.test(statement)) return "browser";
  return "none";
}

/**
 * Derive an acceptance spec from task text. Deterministic: checkboxes first
 * (user-authored order), then "must …" sentences not already covered by a
 * checkbox line. Duplicate statements are dropped (first occurrence wins);
 * ids are content-addressed so they stay stable across extractions.
 */
export function extractAcceptanceFromTask(taskText: string): AcceptanceSpec {
  const statements: string[] = [];
  const seen = new Set<string>();
  const dedupeKey = (s: string) => s.toLowerCase().replace(/[.!?]+$/, "").trim();

  const push = (raw: string) => {
    const statement = raw.trim().replace(/\s+/g, " ");
    if (!statement) return;
    const key = dedupeKey(statement);
    if (seen.has(key)) return;
    seen.add(key);
    statements.push(statement);
  };

  const checkboxRe = new RegExp(CHECKBOX_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = checkboxRe.exec(taskText)) !== null) {
    push(m[1]);
  }

  // Blank the checkbox lines before the must-scan: their content contains
  // "must" too, and a sentence regex would happily re-capture the line
  // including its "- [ ]" marker.
  const restText = taskText.replace(new RegExp(CHECKBOX_RE.source, "g"), "");

  const mustRe = new RegExp(MUST_SENTENCE_RE.source, "gi");
  while ((m = mustRe.exec(restText)) !== null) {
    push(m[0]);
  }

  const items: AcceptanceItem[] = statements.map(statement => ({
    id: `acc-${fnv1a(statement)}`,
    statement,
    verifiedBy: inferVerifiedBy(statement),
    status: "unverified",
  }));
  // Guard against the (astronomically unlikely) content-hash collision so
  // ids stay unique even then.
  const used = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    let id = items[i].id;
    while (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    items[i] = { ...items[i], id };
  }

  return acceptanceSpecSchema.parse({ items, source: "derived" });
}

/** Roll a spec up to counts plus the one bit the gate cares about. */
export function summarizeAcceptance(spec: AcceptanceSpec): AcceptanceSummary {
  let verified = 0;
  let failed = 0;
  let unverified = 0;
  for (const item of spec.items) {
    if (item.status === "verified") verified += 1;
    else if (item.status === "failed") failed += 1;
    else unverified += 1;
  }
  // Complete only when there is something to verify and everything is
  // verified: an empty spec reporting complete would be a lie wearing a
  // success (the same failure mode the reliability plan exists to kill).
  const complete = spec.items.length > 0 && failed === 0 && unverified === 0;
  return { verified, failed, unverified, complete };
}
