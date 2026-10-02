// executor-config.ts — Pure helpers extracted from the executor so the
// env/parse logic is unit-testable without a DB or provider. Everything here
// is deterministic: env in, config out.
import os from "os";

/**
 * Providers that can appear in the AI_FAILOVER chain, with their key env var.
 * Derived from the provider registry (plus the pre-registry `custom` escape
 * hatch), so new elite providers are chain-eligible automatically.
 */
import { failoverKeyEnvMap } from "../provider-registry";

export const FAILOVER_KEY_ENV: Record<string, string> = failoverKeyEnvMap();

/**
 * Opt-in run fan-out. 8 GB target machine: the memory hog is the verify
 * lane's dev server (+0.5-1 GB), which the global verify slot serializes
 * regardless of this number. Default 1 = the historical behavior; values
 * above 3 are refused (hard RAM ceiling, not a suggestion).
 */
export function maxConcurrentRuns(raw: string | undefined): number {
  const n = Number(raw || "");
  // Unset → size to the machine: ≤10GB → 2, ≤16GB → 3, else 5. The 8GB
  // target (i5-8350U) gets 2 concurrent runs — verified to fit in 7.88GB
  // even with one browser-verify lane alive.
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n < 1) {
    const gb = (typeof os !== "undefined" ? os.totalmem() : 8 * 1024 ** 3) / 1024 ** 3;
    return gb <= 10 ? 2 : gb <= 16 ? 3 : 5;
  }
  if (n > 3) return 3;
  return Math.floor(n);
}

/**
 * Parse the AI_FAILOVER chain: comma-separated provider names, in order,
 * skipping the primary itself, unknown providers, and providers whose key
 * env var is unset — a chain entry without a key is a lie.
 */
export function parseFailoverChain(raw: string | undefined, primary: string, env: Record<string, string | undefined>): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => p !== primary)
    .filter((p) => p in FAILOVER_KEY_ENV)
    .filter((p) => Boolean(env[FAILOVER_KEY_ENV[p]]));
}
