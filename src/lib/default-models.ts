/**
 * The models offered out of the box, shown under a persistent "Default Models"
 * group.
 *
 * FREE ONLY as a default. Every free row ends in `:free` on OpenRouter — the
 * default row (`openrouter/free`, first) must never bill the user per token
 * without them having chosen to. Groq was removed (2026-11): its free tier
 * is gone.
 *
 * ONE deliberate exception: `minimax/minimax-m3.1-flash` (verified live,
 * paid) is included as an explicitly-labelled opt-in row — MiniMax has no
 * `:free` variant on OpenRouter (checked 2026-11-09), so a paid id is the
 * only way to offer it. It is NOT first and is clearly tagged "paid".
 *
 * EVERY id was verified against OpenRouter's live /api/v1/models listing, not
 * a search engine. Free tiers rotate, so never add an id here without
 * checking the API first.
 *
 * KEYS MUST BE UNIQUE. The picker renders one row per entry, and React keys
 * the row by model id - two entries sharing an id render as two children with
 * the same key, which React reports as a console error and which can make
 * React drop and re-create rows.
 */

export interface DefaultModelRow {
  key: string;
  name: string;
  tag: string;
  detail?: string;
  group?: string;
}

export const DEFAULT_MODELS: DefaultModelRow[] = [
  // --- Default (free) — first row is the fresh-chat default ---
  { key: "openrouter/free", name: "Free Models Router", tag: "OpenRouter", detail: "free · 200K · tools · always available", group: "Default Models" },

  // --- User-requested premium row (paid, opt-in) ---
  { key: "minimax/minimax-m3.1-flash", name: "MiniMax M3.1 Flash", tag: "OpenRouter", detail: "paid · opt-in", group: "Default Models" },

  // --- OpenRouter free tier: the strongest free models available ---
  { key: "stealth/crouton-alpha", name: "Crouton Alpha", tag: "OpenRouter", detail: "free · 1M · tools · vision", group: "Default Models" },
  { key: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", tag: "OpenRouter", detail: "free · 1M", group: "Default Models" },
  { key: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL", tag: "OpenRouter", detail: "free · 1M · vision · video", group: "Default Models" },
  { key: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning", tag: "OpenRouter", detail: "free · 1M", group: "Default Models" },
  { key: "dots-studio/dots-3-note-preview:free", name: "Dots3-Note Preview", tag: "OpenRouter", detail: "free · 512K · vision", group: "Default Models" },
  { key: "recursive/flint-v1.0:free", name: "Recursive Flint", tag: "OpenRouter", detail: "free · 262K", group: "Default Models" },
  { key: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B", tag: "OpenRouter", detail: "free · 262K · vision", group: "Default Models" },
  { key: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", tag: "OpenRouter", detail: "free · 262K · vision", group: "Default Models" },
  { key: "xingchen-agi/xing4.0-29b-a4b:free", name: "Xing 4.0 29B A4B", tag: "OpenRouter", detail: "free · 262K · tools", group: "Default Models" },
  { key: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni", tag: "OpenRouter", detail: "free · 256K · vision", group: "Default Models" },
  { key: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B", tag: "OpenRouter", detail: "free · 66K · compact", group: "Default Models" },
];
