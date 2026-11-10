/**
 * Guard the DEFAULT_MODELS ids against fabrication.
 *
 * `stealth/space-bunny-alpha:free` was added from a pricing-page listing and
 * shipped; it is not in OpenRouter's live catalogue, so every request to it
 * failed with "model is not responding right now". The web said it existed.
 *
 * This test hits the LIVE /api/v1/models endpoint (cached for the run) and
 * fails if any default id is absent. OpenRouter model ids are stable for
 * months, so a network-dependent test is the right trade here - the alternative
 * is a list that rots silently and only shows up as a user-facing error.
 *
 * Skips (rather than fails) when the network is unavailable, so an offline dev
 * box is not blocked.
 *
 * It also asserts the ids are UNIQUE. The picker renders one row per entry and
 * React keys the row by model id, so a duplicated id renders two children with
 * the same key - React logs a console error and may drop/re-create rows. That
 * shipped once: `nvidia/nemotron-3-ultra-550b-a55b:free` was listed twice
 * after a retired id was renamed onto a live one.
 */

import { DEFAULT_MODELS } from "@/lib/default-models";

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";

let ids: Set<string> | null = null;
/** Live price per id: a model is free when BOTH prompt and completion cost 0. */
let prices: Map<string, { prompt: string; completion: string }> | null = null;
let skipped = false;

beforeAll(async () => {
  try {
    const res = await fetch(OPENROUTER_MODELS, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    ids = new Set((data.data ?? []).map((m) => m.id ?? ""));
    prices = new Map(
      (data.data ?? []).map((m) => [
        m.id ?? "",
        { prompt: m.pricing?.prompt ?? "", completion: m.pricing?.completion ?? "" },
      ]),
    );
  } catch {
    skipped = true;
  }
}, 45_000);

const DEFAULT_KEYS = DEFAULT_MODELS.map((m) => m.key);

/** Ids served by NVIDIA NIM (not OpenRouter) — skip the OpenRouter checks. */
const NON_OPENROUTER_KEYS = new Set(["minimaxai/minimax-m3.1-flash"]);

/** Free ids that carry no `:free` suffix but are still priced 0/0 upstream. */
const FREE_NO_SUFFIX = new Set(["openrouter/free", "minimaxai/minimax-m3.1-flash"]);

describe("default model ids exist upstream", () => {
  it("every DEFAULT_MODELS key is in the live OpenRouter catalogue", () => {
    if (skipped || !ids) {
      console.warn("[skipped] could not reach OpenRouter; id check not run");
      return;
    }
    const missing = DEFAULT_KEYS.filter((k) => !NON_OPENROUTER_KEYS.has(k) && !ids!.has(k));
    expect(missing).toEqual([]);
  });

  it("the picker no longer offers the bogus space-bunny id", () => {
    expect(DEFAULT_KEYS.some((k) => k.includes("space-bunny"))).toBe(false);
  });

  it("contains NO paid models - a default row must never bill the user", () => {
    // Every OpenRouter default must be free. The live catalogue's PRICE is the
    // authority, not the `:free` suffix: `openrouter/free` (the Free Models
    // Router) costs 0 for both directions but carries no suffix, while a `:free`
    // id is only a naming convention. A paid id that merely looked free is
    // exactly the surprise-cost hazard this blocks - a default the user never
    // consciously chose, charging per token.
    if (skipped || !prices) {
      console.warn("[skipped] could not reach OpenRouter; price check not run");
      return;
    }
    const paid = DEFAULT_KEYS.filter((k) => {
      if (NON_OPENROUTER_KEYS.has(k)) return false; // NIM row: free tier by provider
      const p = prices!.get(k);
      if (!p) return false; // missing from the catalogue is caught by the test above
      return p.prompt !== "0" || p.completion !== "0";
    });
    expect(paid).toEqual([]);
  });

  it("labels every default as free", () => {
    for (const k of DEFAULT_KEYS) {
      if (NON_OPENROUTER_KEYS.has(k)) continue; // NIM free row — no OpenRouter price
      if (skipped || !prices) {
        expect(k.endsWith(":free") || FREE_NO_SUFFIX.has(k)).toBe(true);
        continue;
      }
      const p = prices!.get(k);
      if (!p) continue; // missing ids are reported by the catalogue test
      expect(p.prompt === "0" && p.completion === "0").toBe(true);
    }
  });
});

describe("default model ids are unique", () => {
  it("no id appears twice - a duplicate renders two rows with one React key", () => {
    const seen = new Set<string>();
    const duplicates = DEFAULT_KEYS.filter((k) => {
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    expect(duplicates).toEqual([]);
  });

  it("every row has a name and a picker group", () => {
    for (const m of DEFAULT_MODELS) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.group).toBe("Default Models");
    }
  });
});
