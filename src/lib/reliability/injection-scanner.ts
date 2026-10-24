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

const HOMOGLYPHS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x",
  "\u03b1": "a", "\u03b5": "e", "\u03bf": "o",
};

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
  // Every prose phrase is built through `spaced()`, so any run of whitespace
  // may appear between any two characters. That is what makes the rules
  // indifferent to HOW the fold pass rendered an invisible character: whether
  // `ign<ZWSP>ore` became "ign ore" or "ignore", both match. Writing these as
  // literals is what let `ign\u200bore previous instructions` — the prose twin
  // of the tag evasion — pass unflagged.
  { pattern: "ignore-all-previous-instructions", severity: "block", re: () => new RegExp(`\\b(?:${spaced("ignore")}|${spaced("forget")}|${spaced("disregard")})\\s+(?:${spaced("all")}\\s+)?(?:${spaced("previous")}|${spaced("prior")}|${spaced("above")}|${spaced("earlier")})\\s+${spaced("instruction")}s?\\b`, "gi") },
  { pattern: "disregard-system-or-prompt", severity: "block", re: () => new RegExp(`\\b${spaced("disregard")}\\b[^.;\\n]{0,60}?\\b(?:${spaced("system")}|${spaced("developer")}|${spaced("prompt")})\\b`, "gi") },
  // Requires an indefinite article. Bare `you are now` fired on ordinary UI
  // text — "You are now signed in as admin", "You are now ready to continue" —
  // tainting ordinary product files, a changelog, a translation string.
  { pattern: "you-are-now", severity: "block", re: () => new RegExp(`\\b${spaced("you")}\\s+${spaced("are")}\\s+${spaced("now")}\\s+(?:${spaced("a")}|${spaced("an")})\\s`, "gi") },
  { pattern: "new-instructions", severity: "block", re: () => new RegExp(`\\b${spaced("new")}\\s+${spaced("instruction")}s?\\s*:`, "gi") },
  { pattern: "reveal-system-prompt", severity: "block", re: () => new RegExp(`\\b${spaced("reveal")}\\s+${spaced("your")}\\s+(?:${spaced("system")}|${spaced("initial")})\\s+${spaced("prompt")}\\b`, "gi") },
  { pattern: "print-your-instructions", severity: "block", re: () => new RegExp(`\\b${spaced("print")}\\s+${spaced("your")}\\s+${spaced("instruction")}s?\\b`, "gi") },
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
        // `[^>]*` was UNBOUNDED: every `<` in the input drove a scan to
        // end-of-text looking for a `>`, making the whole rule O(n^2). Measured
        // 1 MB of `<tool_call ` = 435 SECONDS of synchronous CPU in the worker
        // tool loop (and it detected nothing, so the burn was pure). The window
        // is bounded to a realistic tag length, which makes it linear; a real
        // tool-call tag is far shorter than 512 chars.
        `<\\/?[\\s${INVISIBLE_BODY}]*(?:${spaced("tool_call")}|${spaced("function_antml")}|${spaced("function=")}|${spaced("antml:")}?)[\\s${INVISIBLE_BODY}]*[^>\\n]{0,512}>`,
        "gi",
      ),
  },
  // Fake tool RESULT tags: fabricated output that reads like a lane result.
  {
    pattern: "fake-tool-result",
    severity: "block",
    re: () =>
      new RegExp(
        `<\\/?[\\s${INVISIBLE_BODY}]*${spaced("tool_result")}[\\s${INVISIBLE_BODY}]*[^>\\n]{0,512}>`,
        "gi",
      ),
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
 * Fold away the evasions that split a token without changing what a reader
 * sees, returning the cleaned text plus an offset map back to the original.
 *
 * Splicing an INVISIBLE class into every rule is whack-a-mole: the class was
 * only ever allowed right after `<`, so `<to\u200bol_call>` and
 * `ign\u200bore previous instructions` both walked straight past every rule —
 * the model reads them as `<tool_call>` and "ignore previous instructions".
 * Doing it ONCE, before any rule runs, covers tag names, prose phrases and
 * separators alike.
 *
 * Invisible characters become a SPACE rather than vanishing. Deleting them
 * would fuse the surrounding words ("you are<ZWSP>now" → "you arenow"), which
 * matches nothing; a space both preserves the word boundary and still breaks
 * the tag name, because the tag patterns are built to tolerate a space between
 * every character (see `spaced`). NFKC additionally folds fullwidth forms
 * (`ｉｇｎｏｒｅ`), another one-line bypass. The map keeps excerpts pointing at
 * the ORIGINAL text.
 */
function foldEvasion(text: string): { text: string; map: number[] } {
  const map: number[] = [];
  let out = "";
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/.test(ch)) {
      out += " ";
      map.push(i);
      i += ch.length;
      continue;
    }
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCharCode(cp - 0xfee0);
      map.push(i);
      i += ch.length;
      continue;
    }
    const homo = HOMOGLYPHS[ch];
    if (homo) {
      out += homo;
      map.push(i);
      i += ch.length;
      continue;
    }
    out += ch;
    map.push(i);
    i += ch.length;
  }
  return { text: out, map };
}

/**
 * Build a regex source for a literal token in which any run of whitespace may
 * appear between EVERY pair of characters — so `tool_call`, `tool call`,
 * `tool<ZWSP>_call` and `t o o l _ c a l l` are all the same pattern. This is
 * what lets a single fold-to-space pass defend tag smuggling without every
 * tag rule carrying its own invisible-character class.
 */
function spaced(literal: string): string {
  return [...literal].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(`[\\s${INVISIBLE_BODY}]*`);
}

/** Inner character class body (no brackets) so `spaced` can embed it. */
const INVISIBLE_BODY = "\\u00AD\\u200B-\\u200F\\u2060-\\u2064\\uFEFF";

/**
 * Scan `text` for injection shapes; findings in first-hit order (multiple
 * patterns can hit the same excerpt — that's desirable evidence, first rule
 * to fire quotes the text once).
 */
export function scanForInjection(input: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  if (typeof input !== "string" || input.length === 0) return findings;
  const folded = foldEvasion(input);
  const text = folded.text;
  const map = folded.map;
  const at = (i: number) => (map[i] === undefined ? 0 : map[i]);

  for (const rule of RULES) {
    const re = rule.re();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        pattern: rule.pattern,
        severity: rule.severity,
        // Quote the ORIGINAL text, not the folded copy, so the excerpt the user
        // is shown is what actually appears in the file.
        excerpt: excerptOf(input, at(m.index), Math.min(m[0].length, input.length - at(m.index))),
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
      excerpt: excerptOf(input, Math.max(0, at(index)), link.display.length + link.href.length + 4),
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
