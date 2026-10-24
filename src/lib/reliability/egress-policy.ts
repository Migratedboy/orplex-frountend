/**
 * reliability/egress-policy.ts — Phase 4: egress allowlist classifier
 * (AUDIT.md §Phase4 "Egress deny / registry proxy: ABSENT — curl
 * https://anything allowed. No allowlist, no proxy.").
 *
 * Companion to exec-guard.ts, NOT a replacement: exec-guard screens the
 * command STRUCTURE (env-prefix, decode-pipe, $(…) substitution) and stays
 * the first screen on every shell route. This module adds the DESTINATION
 * axis exec-guard does not have — where can this command talk to? — and is
 * consumed by capability-policy (rule c: run_command failing classifyEgress
 * is BLOCKED), behind RELIABILITY_CAPABILITY_POLICY (see flags.ts).
 *
 * Defaults: allowlisted registry/bit-host/CI-cache hosts only, everything
 * else (unknown hosts, raw IP literals — the classic malware channel) denied.
 * A network source piped into `sh`/`bash` is denied UNCONDITIONALLY, even
 * when the URL itself would be allowlisted, because the pipe strips the
 * provenance of whatever was fetched.
 */
import type { Provenance } from "./provenance";
import { hasBlockingInjection } from "./injection-scanner";

export interface EgressClassification {
  /** false → the command must not run (capability-policy blocks the call). */
  allowed: boolean;
  /** Why, when not allowed. */
  reason?: string;
  /** Every network destination the command references (lowercased, deduped). */
  destinations: string[];
}

const ALLOWLISTED: readonly string[] = [
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "proxy.golang.org",
  "pypi.org",
  "files.pythonhosted.org",
];

/** scp-style clone targets `git@github.com:org/repo` → github.com */
const SCP_STYLE_RE = /(?:^|[\s"'=])([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):[^\s]/g;

/**
 * bare-host positional targets: `curl example.com/x`. Slash-anchored — a
 * bare host is only a network destination for curl/wget when a PATH follows,
 * which keeps `-o install.sh` style local filenames out of the set.
 */
const BARE_HOST_RE = /(?:^|\s)((?:[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\/[^\s]*)/g;

/** scheme'd URLs anywhere — includes http (denied unless allowlisted). */
const URL_HOST_RE = /(?:^|[\s'"|=(])(https?:\/\/[^\s"'<>\\]+)/gi;

/** git subcommand spans, for the remote-name fallback below. */
const GIT_SUB_RE = /\bgit\s+(?:clone|fetch|push|pull)\b[^\n;&|]*/g;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** True for IPv4 dotted quads, IPv6 hostnames (`[::1]`, `x:x:x::`) — raw
 * address literals are never allowlisted destinations. */
function isRawIp(host: string): boolean {
  if (IPV4_RE.test(host)) return true;
  if (host.startsWith("[") || host.includes("::")) return true;
  return /^([0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}$/.test(host);
}

function collectDestinations(command: string): string[] {
  const hosts = new Set<string>();
  const pushRaw = (h: string | undefined | null) => {
    if (!h || h.length === 0) return;
    hosts.add(h.toLowerCase().replace(/^\[|\]$/g, ""));
  };
  // 1. npm: installs go to the npm registry unless overridden. Include the
  //    default as a destination so an `npm install` command always classifies
  //    against the (allowlisted) registry.
  if (/(?:^|[\s;&])npm\s+(?:install|i|add)\b/.test(command)) {
    hosts.add("registry.npmjs.org");
  }
  // 2. scheme'd URLs (scheme presence makes the intent unambiguous — no host
  //    guessing for local paths).
  for (const m of command.matchAll(URL_HOST_RE)) {
    try {
      pushRaw(new URL(m[1]).hostname);
    } catch {
      // unparseable URL — treat the raw token as its own destination so it
      // still fails the allowlist below; it just won't have a hostname.
      pushRaw(m[1]);
    }
  }
  // 3. scp-style remotes (`git@github.com:...`).
  for (const m of command.matchAll(SCP_STYLE_RE)) {
    pushRaw(m[1].split("@")[1]);
  }
  // 4. bare-host positional curl/wget arguments (scheme omitted).
  for (const m of command.matchAll(BARE_HOST_RE)) {
    pushRaw(m[1].split("/")[0]);
  }
  // 5. git remotes: URL and scp forms are caught above; also take the first
  //    positional argument of git clone/fetch/push/pull. A NAMED remote that
  //    cannot be resolved from the command text (origin, a fork name) is
  //    still a destination candidate: where it egresses to is unknowable
  //    from the string, so strict-by-default treats it as unverified.
  for (const m of command.matchAll(GIT_SUB_RE)) {
    pushRaw(gitFirstRemoteHost(m[0]));
  }
  return [...hosts];
}

/** First positional argument of a git clone/fetch/push/pull span → host-ish
 * destination (URL → hostname, scp → host, other → the token itself). */
function gitFirstRemoteHost(span: string): string | null {
  const tokens = span.split(/\s+/).filter(Boolean);
  let prevWasFlag = false;
  for (const token of tokens) {
    if (token === "git" || /^(?:clone|fetch|push|pull)$/.test(token)) {
      prevWasFlag = false;
      continue;
    }
    if (token.startsWith("-")) {
      prevWasFlag = true;
      continue;
    }
    if (prevWasFlag) {
      // value of the previous flag (e.g. --depth 1, -b main) — not a remote
      prevWasFlag = false;
      continue;
    }
    if (/^https?:/i.test(token)) {
      try {
        return new URL(token).hostname;
      } catch {
        return token;
      }
    }
    if (token.includes("@")) {
      return token.split("@")[1]?.split(":")[0] ?? token;
    }
    return token.split("/")[0].replace(/\.git$/i, "");
  }
  return null;
}

/**
 * The deny that must precede allowlist checks: anything pipe-shaped taking a
 * NEARLY-NETWORK source into a shell. Deliberately over-broad — a `| sh` fed
 * from ANY source the classifier calls network-ish is ALWAYS denied, even
 * allowlisted hosts, because the pipe erases where the payload really came
 * from (the carrier is not the attacker).
 */
export function networkPipedToShell(command: string): boolean {
  return /(?:curl|wget|fetch|iwr|invoke-[^|;&]*|https?:\/\/\S*|git\s+clone\s+\S*scp)[^|;&]*\|\s*(?:sudo\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\b/i.test(command);
}

/**
 * Classify the egress of a command. Pure: no network is attempted, only the
 * command STRING is inspected. Empty/whitespace commands have no destinations
 * and are allowed through (validity is exec-guard's job, not ours).
 */
export function classifyEgress(command: string): EgressClassification {
  const trimmed = command.trim();
  const destinations = trimmed.length === 0 ? [] : collectDestinations(trimmed);

  if (trimmed.length > 0 && networkPipedToShell(trimmed)) {
    return {
      allowed: false,
      reason: "network output piped into a shell interpreter is always denied",
      destinations,
    };
  }

  for (const dest of destinations) {
    if (ALLOWLISTED.includes(dest)) continue;
    if (isRawIp(dest)) {
      return {
        allowed: false,
        reason: `raw IP literal destination "${dest}" is denied — numeric hosts are not on the egress allowlist`,
        destinations,
      };
    }
    return {
      allowed: false,
      reason: `destination "${dest}" is not in the egress allowlist`,
      destinations,
    };
  }

  return { allowed: true, destinations };
}

/** Circular-dep helper (capability-policy ↔ egress-policy): see flags.ts. */
export function egressDenyReason(command: string): string | null {
  const verdict = classifyEgress(command);
  return verdict.allowed ? null : verdict.reason ?? "egress denied";
}

/**
 * Re-exported relay so capability-policy can enforce "untrusted content must
 * not be able to push egress at all" without importing the whole scanner.
 * Null means no policy hit (scan clean, or read of trusted provenance).
 */
export function injectionProvenanceFor(text: string): Provenance | null {
  if (hasBlockingInjection(text)) return "prose_tool";
  return null;
}

// Re-exported flag-independent allowlist for tests and future proxy wiring.
export { ALLOWLISTED as EGRESS_ALLOWLIST };
