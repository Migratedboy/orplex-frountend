import { modelCreator, modelCreatorId, providerIcons, ProviderMark } from "../../components/ProviderIcons";

const cases: Array<[string, string, string]> = [
  ["openai/gpt-oss-120b", "GPT-OSS 120B", "openai"],
  ["gpt-oss-120b", "GPT-OSS 120B", "openai"],
  ["qwen/qwen3.8-27b:free", "Qwen 3.8 27B", "qwen"],
  ["nvidia/nemotron-3-super-120b-a12b:free", "Nemotron Super", "nvidia"],
  ["llama-3.3-70b-versatile", "Llama 3.3 70b", "meta"],
  ["meta-llama/llama-3.1-8b-instant", "Llama 3.1 8b", "meta"],
  ["deepseek-r1-distill-llama-70b", "DeepSeek R1 Distill", "deepseek"],
  ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic"],
  ["claude-3-5-haiku", "Claude 3.5 Haiku", "anthropic"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro", "google"],
  ["gemini-2.5-flash", "Gemini Flash", "google"],
  ["mistralai/mistral-small-3.1", "Mistral Small 3.1", "mistral"],
  ["mixtral-8x7b-32768", "Mixtral 8x7B", "mistral"],
  ["x-ai/grok-4-fast", "Grok 4 Fast", "xai"],
  ["grok-4", "Grok 4", "grok"],
  ["microsoft/phi-4", "Phi-4", "microsoft"],
  ["amazon/nova-pro-v1", "Nova Pro", "amazon"],
  ["moonshotai/kimi-k2-instruct", "Kimi K2", "kimi"],
  ["moonshotai/moonshot-v1", "Moonshot V1", "moonshot"],
  ["databricks/dbrx-instruct", "DBRX", "databricks"],
  ["ibm-granite/granite-13b", "Granite 13B", "ibm"],
  ["nova-3", "Nova 3", "amazon"],
  ["z-ai/glm-5.3", "GLM 5.3", "zhipu"],
  ["zhipuai/glm-4-plus", "GLM 4 Plus", "zhipu"],
  ["minimaxai/minimax-m3", "MiniMax M3", "minimax"],
  ["cohere/c4ai-embed-v3", "Cohere Embed", "cohere"],
  // Hosting platforms are NOT creators — these must fall through to null.
  ["some-unknown-model", "Mystery Model", ""],
  ["totally-random-id", "Random", ""],
];

describe("providerIcons creator map", () => {
  it.each(cases)("maps %s / %s → %s", (key, name, expected) => {
    const creator = modelCreator({ key, name });
    expect(creator?.id ?? "").toBe(expected);
  });

  it("never yields an empty id for an unmapped model", () => {
    expect(modelCreatorId({ key: "nope", name: "nope" })).toBe("");
    expect(modelCreator({ key: "", name: "" })).toBeNull();
    expect(modelCreator(null)).toBeNull();
  });

  it("keys groups by creator so identical creators share a bucket", () => {
    const a = modelCreatorId({ key: "openai/gpt-oss-120b", name: "A" });
    const b = modelCreatorId({ key: "gpt-4o", name: "B" });
    const c = modelCreatorId({ key: "llama-3.3-70b", name: "C" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("renders a mark for every registry entry (and for the fallback)", () => {
    for (const [, entry] of Object.entries(providerIcons)) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.Icon).toBe("function");
      expect(entry.Icon({ size: 16 })).toBeTruthy();
    }
    expect(ProviderMark({ model: { key: "unknown", name: "unknown" }, size: 16 })).toBeTruthy();
  });
});
