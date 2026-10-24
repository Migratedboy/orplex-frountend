/**
 * reliability/scrubber.ts — Phase 4: output scrubbing before tool output
 * enters LLM context (AUDIT.md §Phase4 "Output scrubbing: PARTIAL —
 * secret-scanner-plugin.ts scans write_file/edit_file content only. No
 * redaction of tool output before it enters LLM context. read_file returns
 * .env verbatim; client-signatures.ts:119 even boosts .env into context.").
 *
 * Detection patterns are MIRRORED from
 * src/lib/plugins/builtin/secret-scanner-plugin.ts (its SECRET_PATTERNS array
 * is file-private — only scanContentForSecrets() is exported, and it returns
 * kinds, not match positions, which is not enough to redact). The mirrored
 * set is grown to the untrusted-output axis the plugin never had: Bearer /
 * JWT headers, PEM blocks, .env-style assignments, provider key shapes
 * (sk-/gsk_/nvapi-/AKIA). Keep the two lists in step if either changes.
 *
 * Redaction shape: `[REDACTED:<kind>]`; for long secrets the first/last 4
 * chars of the secret are preserved (forensics without the value).
 * SCRUB_MAX_CHARS bounds the work: content longer than that is truncated
 * with an explicit marker BEFORE scanning (defense against regex blowup on
 * multi-megabyte tool output).
 *
 * Scanning is strictly single-pass per pattern: after every replacement the
 * scanner resumes AFTER the injected marker, so a marker can never be found
 * and re-grown by a later rule (checked: no rule's class reaches into
 * `[REDACTED:…]` punctuation, and marker kind names never re-trigger a later
 * keyword, because keyword rules require a `\b` before the key and marker
 * kind words sit after an underscore).
 *
 * Pure text→text; nothing here decides whether to run — callers gate on
 * reliabilityScrubbingEnabled() (RELIABILITY_SCRUB, flags.ts).
 */

export const SCRUB_MAX_CHARS = 20000;

export interface SecretRedaction {
  /** Stable kind id, e.g. "provider_key" / "bearer_token" / "env_value". */
  kind: string;
  /** Count of separate matches replaced for this kind in one scrub. */
  count: number;
}

export interface ScrubResult {
  /** The scrubbed (and possibly truncated) text. */
  text: string;
  /** Per-kind redaction counts, in first-match order. */
  redactions: SecretRedaction[];
  /** True when the input was truncated before scanning. */
  truncated: boolean;
}

interface Pattern {
  re: RegExp;
  kind: string;
  /** When set, replace ONLY this capture group (the key/label stays). */
  valueGroup?: number;
  /**
   * Emit a bare `[REDACTED:kind]` with no first/last-4 fragment. Used for
   * STRUCTURED secrets whose extremities carry no forensic value — a PEM
   * block's first 4 chars are `----` and its last 4 are `----`, so a fragment
   * would read as `[REDACTED:private_key:----…----]`, telling the model
   * nothing while implying it was told something.
   */
  noFragment?: boolean;
}

// Mirrored from plugins/builtin/secret-scanner-plugin.ts SECRET_PATTERNS,
// extended with the output-shapes listed in the header note. Order matters:
// longest / most specific shapes first — a Stripe `sk_live` wins over the
// generic `sk-`; a JWT wins over `Bearer <jwt>`; a PEM block wins over any
// key/value inside it; earlier redactions' markers must never re-trigger a
// later keyword (verified per kind, see the header note).
const SECRET_PATTERNS: Pattern[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/, noFragment: true },
  { kind: "stripe_key", re: /(?:sk_live|pk_live|sk_test|pk_test)[A-Za-z0-9_]{20,}/ },
  { kind: "provider_key", re: /\bgsk_[A-Za-z0-9_\-]{16,}\b/ },
  { kind: "provider_key", re: /\bnvapi-[A-Za-z0-9_\-]{16,}\b/ },
  { kind: "provider_key", re: /\bsk-[A-Za-z0-9_\-]{20,}\b/ },
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github_token", re: /\bghp_[A-Za-z0-9_]{36}\b/ },
  { kind: "slack_token", re: /\bxox[bpsa]-[A-Za-z0-9\-]{10,}\b/ },
  { kind: "google_api_key", re: /\bAIza[A-Za-z0-9_\-]{35}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*\b/ },
  { kind: "bearer_token", re: /\bBearer\s+["']?([A-Za-z0-9_\-./=+]{10,})/i, valueGroup: 1 },
  // Key=value families: group 1 is the value so labels stay readable.
  {
    kind: "api_key",
    re: /\b(?:api[_-]?key|apikey)\s*[=:]\s*(["'][^"'\r\n]*["']|[^\s"'…,;:=()\[\]{}]{8,})/,
    valueGroup: 1,
  },
  {
    kind: "password",
    re: /\b(?:password|passwd|pwd)\s*[=:]\s*(["'][^"'\r\n]*["']|[^\s"'…,;:=()\[\]{}]{8,})/,
    valueGroup: 1,
  },
  {
    kind: "secret",
    re: /\b(?:secret|secret[_-]?key)\s*[=:]\s*(["'][^"'\r\n]*["']|[^\s"'…,;:=()\[\]{}]{8,})/,
    valueGroup: 1,
  },
  {
    kind: "token",
    re: /\b(?:token|access[_-]?token|auth[_-]?token)\s*[=:]\s*(["'][^"'\r\n]*["']|[^\s"'…,;:=()\[\]{}]{8,})/,
    valueGroup: 1,
  },
  {
    kind: "aws_secret",
    re: /\b(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*(["'][^"'\r\n]*["']|[^\s"'…,;:=()\[\]{}]{8,})/,
    valueGroup: 1,
  },
  {
    kind: "env_value",
    // The name must be allowed to BE the keyword. The previous pattern required
    // `[A-Za-z_][A-Za-z0-9_]*` before `(?:KEY|TOKEN|…)`, i.e. at least one
    // character in front — so `PASSWORD=x` only matched by accident (P+PASSWORD)
    // while `TOKEN=`, `KEY=`, `SECRET=`, `SALT=`, `DSN=`, `CREDENTIAL=` and
    // `PRIVATE=` could NEVER match, and neither could `DATABASE_URL=` (URL is
    // not in the keyword list). That is the module's own motivating case
    // (`read_file` returns .env verbatim) leaking in cleartext. The first
    // alternative is now `KEYWORD` on its own, the second `PREFIX_KEYWORD`.
    re: /(?:^|\r?\n)[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|SALT|DSN|AWS_ACCESS|PRIVATE|DATABASE_URL|_URL|URL)[A-Za-z0-9_]*|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|SALT|DSN|PRIVATE)(\s*=\s*)([^\r\n]*)/,
    valueGroup: 3,
  },
  // Connection strings carry a username AND a password in the authority
  // position — the single most common secret shape in real tool output (a
  // docker-compose, a README, an ORM error string, a psql banner). Previously
  // zero coverage, and it compounded the env_value gap above.
  {
    kind: "connection_string",
    // The `@` must be a LOOKAHEAD, not part of the match: scrubOnce computes
    // the kept prefix as `raw.slice(0, raw.length - secretPart.length)`, which
    // assumes the match ENDS with the secret. With the `@` inside the match the
    // arithmetic was off by the separator, emitting `postgres://admin:s[REDACTED…]host`
    // — a stray trailing char of the username and a deleted `@`.
    re: /\b([a-z][a-z0-9+.\-]*:\/\/)([^\s:/@]+):([^\s@/]+)(?=@)/gi,
    valueGroup: 3,
  },
  // Auth headers other than Bearer. `Basic` is base64 and trivially reversible,
  // so the model received `user:password` verbatim. Cookies are the canonical
  // session-token carrier and appear in curl -v, HTTP dumps and traces.
  { kind: "basic_auth", re: /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/g, valueGroup: 1 },
  {
    kind: "cookie",
    re: /\b((?:set-)?cookie)\s*:\s*([^\r\n]+)/gi,
    valueGroup: 2,
  },
  // AWS STS temporary credentials use ASIA, not AKIA, and ship as a
  // session-token pair — the standard shape in any CloudTrail or CLI dump.
  { kind: "aws_key", re: /\bASIA[0-9A-Z]{16}\b/ },
  // Stripe RESTRICTED keys. The live/test variants were covered; the restricted
  // pair (the one every modern integration uses) was not covered at all.
  { kind: "stripe_key", re: /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // GitHub: ghp_ is only one of six prefixes, and the fine-grained PAT is
  // longer than the fixed {36} the old pattern anchored to.
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { kind: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  // Slack app-level (`xapp-`) and read-only (`xoxr-`) tokens.
  { kind: "slack_token", re: /\bx(?:ox[bpsar]|app)-[A-Za-z0-9-]{10,}\b/ },
  { kind: "provider_key", re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { kind: "provider_key", re: /\bsk-proj-[A-Za-z0-9_\-]{20,}\b/ },
  { kind: "provider_key", re: /\bhf_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\br8_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bAIza[A-Za-z0-9_\-]{35}\b/ },
  { kind: "provider_key", re: /\bnvapi-[A-Za-z0-9_\-]{16,}\b/ },
  { kind: "provider_key", re: /\bgsk_[A-Za-z0-9_\-]{16,}\b/ },
  { kind: "provider_key", re: /\bphc_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/ },
  { kind: "provider_key", re: /\bxai-[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bpplx-[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bfc-[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bkey-[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bsecret_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\btoken_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bpat_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bctx7sk-[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bdsn_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bwhsec_[A-Za-z0-9]{20,}\b/ },
  { kind: "provider_key", re: /\bre_[A-Za-z0-9]{20,}\b/ },
];

/** Wrap `secret` in the redaction marker, keeping first/last 4 chars when
 * there is enough material to be worth keeping (>= 12 raw chars). Quotes and
 * surrounding whitespace are not "material" — stripped before fragmenting, so
 * a quoted secret redacts to `[REDACTED:kind:abcd…mnop]` and not to
 * `[REDACTED:kind:"abcd…mnop"]` (which would leave the quote characters in the
 * model's context and break any downstream parse of the line). */
function redactToken(secret: string, kind: string, noFragment = false): string {
  // Peel matched surrounding quotes, then whitespace. Only ONE layer: a value
  // that is genuinely `"abc"` has real quotes in it.
  const unwrapped = secret.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  if (!noFragment && unwrapped.length >= 12) {
    return `[REDACTED:${kind}:${unwrapped.slice(0, 4)}…${unwrapped.slice(-4)}]`;
  }
  return `[REDACTED:${kind}]`;
}

function scrubOnce(text: string): { text: string; redactions: SecretRedaction[] } {
  const redactions: SecretRedaction[] = [];
  let result = text;

  for (const { re, kind, valueGroup, noFragment } of SECRET_PATTERNS) {
    const scanner = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let count = 0;
    for (;;) {
      const m = scanner.exec(result);
      if (m === null) break;
      if (m[0].length === 0) {
        scanner.lastIndex++;
        continue;
      }
      const raw = m[0];
      const secretPart = valueGroup !== undefined && m[valueGroup] !== undefined ? m[valueGroup] : raw;
      const prefix = raw.slice(0, raw.length - secretPart.length);
      const replacement = prefix + redactToken(secretPart, kind, noFragment === true);
      result = result.slice(0, m.index) + replacement + result.slice(m.index + raw.length);
      count++;
      // Resume AFTER the marker: the replacement text is never rescanned by
      // this (or any later) rule, so markers cannot compound.
      scanner.lastIndex = m.index + replacement.length;
    }
    if (count > 0) redactions.push({ kind, count });
  }

  return { text: result, redactions };
}

/**
 * Scrub secrets out of untrusted tool output before it enters the model
 * context. Truncates over-long input first (explicit marker), then applies
 * every pattern. Deterministic and pure.
 */
export function scrubSecrets(text: string): ScrubResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text, redactions: [], truncated: false };
  }
  let truncated = false;
  let candidate = text;
  if (candidate.length > SCRUB_MAX_CHARS) {
    candidate = candidate.slice(0, SCRUB_MAX_CHARS);
    truncated = true;
  }
  const { text: scrubbed, redactions } = scrubOnce(candidate);
  const suffix = truncated
    ? `[SCRUB_TRUNCATED: original ${text.length} chars, truncated to ${SCRUB_MAX_CHARS} chars before scanning]`
    : "";
  return { text: scrubbed + suffix, redactions, truncated };
}

/**
 * Scrub an .env-STYLE file: redact the value of EVERY assignment (not only
 * secret-looking keys — a bespoke env var is far more dangerous if it moves
 * through chat than a missed redaction is annoying to a developer reading it
 * back). Keys and structure (export prefixes, separators, comments) preserved.
 */
export function scrubEnvFileContent(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(
    // The `export` prefix is captured (not consumed) so it survives into the
    // output — a scrubbed .env that has silently become invalid shell is a
    // bug the redaction itself introduced.
    /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([^\r\n]*)$/gm,
    (_whole, prefix: string, key: string, eq: string, value: string) =>
      `${prefix}${key}${eq}${redactToken(value, "env_value")}`,
  );
}
