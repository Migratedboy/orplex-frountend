// embeddings.ts — Free local text embeddings for workspace memory.
//
// Model: Xenova/all-MiniLM-L6-v2 (~25 MB ONNX, 384 dims) running on CPU via
// @huggingface/transformers. Weights cache under .orplex/models/ on the
// user's machine — no API keys, no per-call cost, no data leaves the box.
//
// Design: lazy single-flight init (the first embed call loads the model once;
// concurrent callers await the same promise). Loading is time-bounded by
// ORPLEX_EMBED_TIMEOUT_MS — if the first load takes longer, callers get null
// and the retrieval layer falls back to the lexical scorer; init keeps
// running in the background so later calls succeed. Every failure mode
// degrades to null, never throws into a task.

import path from "path";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;
const MAX_INPUT_CHARS = 2000; // MiniLM context is 256 tokens — hard-truncate

type Extractor = (
  text: string,
  opts?: Record<string, unknown>
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

let extractor: Extractor | null = null;
let initPromise: Promise<Extractor | null> | null = null;
let failed = false;

/** Mean-pool a [1, seq, dim] tensor over the sequence axis + L2 normalize. */
function poolAndNormalize(data: Float32Array, dims: readonly number[]): Float32Array {
  let out: Float32Array;
  if (dims.length === 3 && dims[1] > 1) {
    const seq = dims[1];
    const dim = dims[2] || EMBED_DIM;
    out = new Float32Array(dim);
    for (let t = 0; t < seq; t++) {
      for (let d = 0; d < dim; d++) out[d] += data[t * dim + d];
    }
    for (let d = 0; d < dim; d++) out[d] /= seq;
  } else {
    out = data.slice(0, EMBED_DIM);
  }
  let norm = 0;
  for (let d = 0; d < out.length; d++) norm += out[d] * out[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < out.length; d++) out[d] /= norm;
  return out;
}

async function initExtractor(): Promise<Extractor | null> {
  try {
    const tf = await import("@huggingface/transformers");
    // Weights cache lives in the user's workspace dir, next to the DB.
    tf.env.cacheDir =
      process.env.ORPLEX_MODEL_CACHE || path.join(process.cwd(), ".orplex", "models");
    const pipe = await tf.pipeline("feature-extraction", EMBED_MODEL);
    extractor = pipe as unknown as Extractor;
    return extractor;
  } catch (err) {
    // Permanent for this process: repeated retries would stall every request
    // by the timeout. A process restart (or ORPLEX_EMBED_ENABLED=0 flip)
    // retries the load.
    failed = true;
    console.error(
      `[embeddings] model load failed — embedding retrieval disabled (lexical fallback active): ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Embed one text. Returns null when embeddings are disabled, still loading
 * past the timeout, or permanently failed — callers fall back to lexical.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (process.env.ORPLEX_EMBED_ENABLED === "0") return null;
  // Tests never load the model (or run onnxruntime) — deterministic fallback.
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === "test") return null;
  const input = (text || "").slice(0, MAX_INPUT_CHARS);
  if (!input.trim()) return null;
  if (failed && !extractor) return null;

  if (!extractor && !initPromise) {
    initPromise = initExtractor();
  }
  if (!extractor && initPromise) {
    const timeoutMs = Number(process.env.ORPLEX_EMBED_TIMEOUT_MS || 0) || 20_000;
    const warmed = await Promise.race([
      initPromise.then((e) => e !== null),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    if (!warmed) return null; // still downloading — init continues in background
  }
  if (!extractor) return null;

  try {
    const out = await extractor(input, { pooling: "mean", normalize: true });
    return poolAndNormalize(out.data, out.dims);
  } catch {
    return null;
  }
}

/** Embed a batch; entries that fail keep their key mapped to null. */
export async function embedBatch(texts: string[]): Promise<Map<string, Float32Array | null>> {
  const out = new Map<string, Float32Array | null>();
  // Single-flight init: prime once, then embed sequentially (CPU pipeline is
  // not meaningfully parallel at this scale).
  for (const t of texts) {
    out.set(t, await embedText(t));
  }
  return out;
}

/** Cosine similarity between two unit-ish vectors. 0 on any mismatch. */
export function cosineSimilarity(a: Float32Array, b: number[] | Float32Array): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const bv = b[i] ?? 0;
    dot += a[i] * bv;
    na += a[i] * a[i];
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
