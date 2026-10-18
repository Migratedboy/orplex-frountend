/**
 * reliability/injection-scanner.ts — Phase 4: prompt-injection detection over
 * untrusted content (AUDIT.md §Phase4 "Injection scanner: ABSENT").
 *
 * Scope: FILE CONTENT AND TOOL OUTPUT that is about to enter LLM context —
 * READMEs, web fetched pages, command stdout. The model reads it; if the text
 * says "ignore all previous instructions" the strongest defence today is the
 * run_command denylist, i.e. the model has to be tempted all the way into the
 * exec route before anything objects. This module objects EARLIER, on the
 * text itself, and returns findings; enforcement belongs to the caller
 * (capability-policy consults it too — see the prose_tool relay below).
 *
 * Everything is pure regex over plain text — no decoding, no dependencies
 * (D-5). Case-insensitive, word-boundary anchored so plain English about
 * instructions ("follow the previous instructions in this file") does not
 * trip the matcher, excerpt shows ±80 chars of proof for annotation.
 */
import type { Provenance } from "./provenance";

export interface InjectionFinding {
  /** Stable kebab-case pattern id, one per rule hit. */
  pattern: string;
  /** "block" = coercing/overriding language; "warn" = annotates only. */
  severity: "block" | "warn";
  /** The matched text ±80 chars for display / the report. */
  excerpt: string;
}

const EXCERPT_RADIUS = 80;

function excerptOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return text.slice(start, end);
}

interface InjectionRule {
  pattern: string;
  severity: "block" | "warn";
  /** GLOBAL regex per scan — exec() walks match by match in scanForInjection. */
  re: () => RegExp;
}

/**
 * rule ids and severities:
 *  - coercion ("ignore previous", "disregard system", "you are now",
 *    "new instructions:", "reveal your prompt", "print your instructions",
 *    fake tool-call / tool-result markup) → BLOCK: each is either an
 *    instruction override or tool-call smuggling.
 *  - action bait ("run the following command", "execute this"), base64 blobs
 *    (>80 raw base64 chars — an obfuscated payload for the reader to decode),
 *    hidden markdown links (display text differing from the href) → WARN:
 *    annotating signals, not refusals on their own.
 */
/**
 * Characters an injection payload uses to SPLIT a tag name so a naive
 * `<tool_call` literal fails to match — the standard evasion for a text scanner
 * guarding a tag-parsing agent loop: the model still reads `tool_call`, the
 * regex sees `tool\u200b_call`. U+200B..U+200F are the zero-width
 * space/non-joiner/joiner/ZWL/ZWNJ, U+2060..U+2064 the invisible operators,
 * U+FEFF a BOM used mid-stream, U+00AD a soft hyphen.
 */
const INVISIBLE = "[\\u00AD\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]";

const RULES: InjectionRule[] = [
  { pattern: "ignore-all-previous-instructions", severity: "block", re: () => /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/gi },
  { pattern: "disregard-system-or-prompt", severity: "block", re: () => /\bdisregard\b[^.;\n]{0,60}?\b(?:system|developer|prompt)\b/gi },
  { pattern: "you-are-now", severity: "block", re: () => /\byou\s+are\s+now\b/gi },
  { pattern: "new-instructions", severity: "block", re: () => /\bnew\s+instructions\s*:/gi },
  { pattern: "reveal-system-prompt", severity: "block", re: () => /\breveal\s+your\s+(?:system|initial)\s+prompt\b/gi },
  { pattern: "print-your-instructions", severity: "block", re: () => /\bprint\s+your\s+instructions\b/gi },
  // Tool-call smuggling: every markup hue a repo's tool loop can parse — the
  // `<tool_call>` form (stream-reader.ts), `<function=…>` (api agents),
  // `<antml:…>`/`function_antml` wrappers seen in the wild. Opening AND closing
  // forms both matter: `</tool_call>` is how a payload ends a smuggled block,
  // and a scanner that only opens would let the rest of the text ride inside
  // it. Invisible chars are tolerated right after `<` and after `</`.
  {
    pattern: "tool-call-smuggling",
    severity: "block",
    re: () =>
      new RegExp(
        `<\\/?${INVISIBLE}*(?:tool_call|function_antml|function=|antml:?)${INVISIBLE}*[^>]*>`,
        "gi",
      ),
  },
  // Fake tool RESULT tags: fabricated output that reads like a lane result.
  {
    pattern: "fake-tool-result",
    severity: "block",
    re: () => new RegExp(`<\\/?${INVISIBLE}*tool_result${INVISIBLE}*[^>]*>`, "gi"),
  },
  { pattern: "run-following-command", severity: "warn", re: () => /\brun\s+the\s+following\s+command\b/gi },
  { pattern: "execute-this", severity: "warn", re: () => /\bexecute\s+this\b/gi },
  { pattern: "base64-blob", severity: "warn", re: () => /[A-Za-z0-9+/=]{80,}/gi },
];

interface MarkdownLinkParts {
  display: string;
  href: string;
}

const MARKDOWN_LINK_RE = /[!?\[]([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;

function markdownLinks(text: string): MarkdownLinkParts[] {
  const links: MarkdownLinkParts[] = [];
  let m: RegExpExecArray | null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((m = MARKDOWN_LINK_RE.exec(text)) !== null) {
    links.push({ display: m[1], href: m[2] });
  }
  return links;
}

function normalizeDisplay(display: string): string {
  return display.trim().toLowerCase();
}

function normalizeHref(href: string): string {
  return href.trim().toLowerCase().replace(/\/+$/, "");
}

/** True when the display text does not have a sensible relation to the href. */
function isHiddenLink(link: MarkdownLinkParts): boolean {
  const display = normalizeDisplay(link.display);
  const href = normalizeHref(link.href);
  if (display.length === 0) return false;
  if (href.includes(display)) return false;
  if ((new URL(href)).hostname.includes(display.replace(/^https?:\/\//, ""))) return false;
  return true;
}

/**
 * Scan `text` for injection shapes; findings in first-hit order (multiple
 * patterns can hit the same excerpt — that's desirable evidence, first rule
 * to fire quotes the text once).
 */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  if (typeof text !== "string" || text.length === 0) return findings;

  for (const rule of RULES) {
    const re = rule.re();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        pattern: rule.pattern,
        severity: rule.severity,
        excerpt: excerptOf(text, m.index, m[0].length),
      });
      if (m[0].length === 0) break; // zero-width guard; none of the rules are
      // empty by construction, so this can only loop-guard a bad edit.
    }
  }

  for (const link of markdownLinks(text)) {
    if (!isHiddenLink(link)) continue;
    const index = text.indexOf(`[${link.display}]`);
    findings.push({
      pattern: "hidden-markdown-link",
      severity: "warn",
      excerpt: excerptOf(text, Math.max(0, index), link.display.length + link.href.length + 4),
    });
  }
  return findings;
}

/** True when scanForInjection would find at least one BLOCK finding. */
export function hasBlockingInjection(text: string): boolean {
  return scanForInjection(text).some((f) => f.severity === "block");
}

/**
 * Relay: scan-for-injection → taint provenance. When a text is consumed via a
 * call path that reports provenance, untrusted scanned content should be
 * promoted AT LEAST to `prose_tool` (so writes with that provenance require
 * policy refusal; capability-policy implements the enforcement). Null when
 * the flag is off or nothing blocks — the relay must stay inert unless the
 * master chain (RELIABILITY_GATES=1, RELIABILITY_INJECTION_SCAN=1) is armed.
 */
export function injectionTaintedProvenance(text: string): Provenance | null {
  if (hasBlockingInjection(text)) return "prose_tool";
  return null;
}
