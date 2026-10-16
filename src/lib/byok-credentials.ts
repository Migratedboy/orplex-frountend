// byok-credentials.ts — Resolve the API key a RUN should actually use.
//
// The wrong-source bug this fixes: the server executor built its adapter from
// process.env only (createProviderAdapter -> process.env[def.keyEnvVar]). The
// chat lane, meanwhile, resolved the user's own UserApiKey rows first. So a
// user who had paid for and configured a key in Settings got it honoured in
// chat and completely ignored in background runs — their runs silently
// executed on the platform's free shared key, against a model they never
// picked. The per-user value existed, was correct, and was never consulted.
//
// Resolution order (most specific first):
//   1. a key whose own catalogue contains the requested model id — proof the
//      key can actually serve what the run asks for;
//   2. the most recently added active key.
// Falls back to null so callers keep their existing env behaviour.
//
// SAFETY: keys are decrypted in memory only, never returned to a client,
// never logged, and every failure resolves to "no credential" rather than
// throwing — a broken key must never take the executor down.

import { prisma } from "./prisma";
import { decryptKey } from "./key-encryption";
import { getProviderDef } from "./provider-registry";

export interface ResolvedCredential {
  provider: string;
  /** Decrypted key. In-memory only; treat as a secret. */
  apiKey: string;
  /** The key's configured default model, when it has one. */
  model?: string;
  /**
   * True when the provider is free-tier-only (Groq/NVIDIA free keys, Gemini's
   * free allowance, etc.). Used to decide whether platform free-tier shaping
   * and quota rules apply — a paid key must never inherit free-tier limits,
   * and a free key must never be treated as if it lifted them.
   */
  isFreeTier: boolean;
  keyId: string;
}

/** Strip an OpenRouter-style namespace for comparison. */
function bare(id: string): string {
  const s = (id || "").trim();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Best active key for this user, or null when they have none usable.
 * `requestedModel` refines the choice but is never required.
 */
export async function resolveRunCredential(
  userId: string,
  requestedModel?: string | null
): Promise<ResolvedCredential | null> {
  if (!userId) return null;
  try {
    const rows = await prisma.userApiKey.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { id: true, provider: true, apiKey: true, model: true, modelsCache: true },
    });

    const usable = rows
      .map((row) => {
        let apiKey = "";
        try {
          apiKey = decryptKey(row.apiKey);
        } catch {
          return null; // undecryptable (rotated secret) — skip, never throw
        }
        if (!apiKey) return null;
        const def = getProviderDef(row.provider);
        if (!def) return null; // provider no longer in the registry
        return {
          id: row.id,
          provider: row.provider,
          apiKey,
          model: row.model || undefined,
          isFreeTier: def.free === true,
          ids: Array.isArray(row.modelsCache)
            ? (row.modelsCache as Array<{ id?: unknown }>)
                .map((m) => (typeof m?.id === "string" ? m.id : ""))
                .filter(Boolean)
            : [],
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (usable.length === 0) return null;

    // Prefer a key that provably serves the requested model. Exact id first,
    // then the namespace-stripped form (OpenRouter serves `openai/gpt-4o`;
    // NVIDIA's own catalogue lists `gpt-4o` for some families).
    const want = (requestedModel || "").trim();
    let chosen = usable[0];
    if (want) {
      const exact = usable.find((r) => r.ids.includes(want));
      const loose = usable.find((r) => r.ids.some((id) => bare(id) === bare(want)));
      chosen = exact ?? loose ?? usable[0];
    }

    return {
      provider: chosen.provider,
      apiKey: chosen.apiKey,
      model: chosen.model,
      isFreeTier: chosen.isFreeTier,
      keyId: chosen.id,
    };
  } catch {
    return null;
  }
}