// Ambient types for the OPTIONAL embeddings stack.
//
// @huggingface/transformers is deliberately NOT a dependency of the frontend
// (onnxruntime-node is a heavy native module that would bloat/break the
// desktop bundle). embeddings.ts loads it via dynamic import() inside
// try/catch and degrades to lexical scoring when absent — so the compiler
// only needs the shape used there, declared here instead of installed.
declare module "@huggingface/transformers" {
  export const env: {
    cacheDir?: string;
    [key: string]: unknown;
  };
  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}
