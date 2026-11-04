// model-context-windows.test.ts — the model-id/context-window helpers pulled
// out of /api/chat/route.ts. Pins: bare-id lookup ("team/gpt-5" falls back to
// "gpt-5"), the never-throw contract (catalog failure = empty map, safe
// default downstream), and zero-window models being skipped.

jest.mock("@/lib/model-catalog", () => ({
  getVerifiedModels: jest.fn(),
}));

import { getVerifiedModels } from "@/lib/model-catalog";
import {
  bareModelId,
  contextWindowForModel,
  loadContextWindows,
} from "../model-context-windows";

const mockedGetVerifiedModels = getVerifiedModels as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("bareModelId", () => {
  it("strips an OpenRouter-style namespace", () => {
    expect(bareModelId("openai/gpt-4o")).toBe("gpt-4o");
  });

  it("keeps plain ids intact and tolerates empty values", () => {
    expect(bareModelId("gpt-4o")).toBe("gpt-4o");
    expect(bareModelId("")).toBe("");
    expect(bareModelId("  gpt-5  ")).toBe("gpt-5");
  });
});

describe("loadContextWindows", () => {
  it("builds both the exact and the bare-id lookup", async () => {
    mockedGetVerifiedModels.mockResolvedValue({
      models: [
        { id: "meta-org/llama-4", contextWindow: 131_072 },
        { id: "gpt-5g", contextWindow: 400_000 },
      ],
    });
    const map = await loadContextWindows();
    expect(map.get("meta-org/llama-4")).toBe(131_072);
    expect(map.get("llama-4")).toBe(131_072);
    expect(map.get("gpt-5g")).toBe(400_000);
  });

  it("never throws — a failing catalog is an empty map (safe default)", async () => {
    mockedGetVerifiedModels.mockRejectedValueOnce(new Error("catalog down"));
    const map = await loadContextWindows();
    expect(map.size).toBe(0);
  });

  it("skips non-numeric and zero/no window entries", async () => {
    mockedGetVerifiedModels.mockResolvedValue({
      models: [
        { id: "a/unknown-window" },
        { id: "b/zero-window", contextWindow: 0 },
      ],
    });
    const map = await loadContextWindows();
    expect(map.size).toBe(0);
  });

  it("does not overwrite an exact id already mapped to a window", async () => {
    mockedGetVerifiedModels.mockResolvedValue({
      models: [{ id: "x/llama-4", contextWindow: 8_000 }],
    });
    const map = await loadContextWindows();
    expect(map.get("x/llama-4")).toBe(8_000);
    expect(map.get("llama-4")).toBe(8_000);
  });
});

describe("contextWindowForModel — the lookup both lanes pay for", () => {
  const windows = new Map<string, number>([
    ["vendor-alpha/model-longname", 16_000],
    ["model-longname", 8_000],
    ["seed/gpt", 32_000],
  ]);

  it("uses the exact id when present", () => {
    expect(contextWindowForModel(windows, "vendor-alpha/model-longname")).toBe(16_000);
  });

  it("falls back to the bare id when the exact id is missing", () => {
    expect(contextWindowForModel(windows, "vendor-beta/model-longname")).toBe(8_000);
  });

  it("returns undefined for unknown models and handles empty ids", () => {
    expect(contextWindowForModel(windows, "mystery-model")).toBeUndefined();
    expect(contextWindowForModel(windows, "")).toBeUndefined();
    expect(contextWindowForModel(windows, undefined as unknown as string)).toBeUndefined();
  });

  it("matches ids that merely contain extra spacing (trimmed before lookup)", () => {
    expect(contextWindowForModel(windows, " seed/gpt ")).toBe(32_000);
  });
});
