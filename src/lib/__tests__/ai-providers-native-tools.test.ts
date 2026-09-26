// ai-providers-native-tools.test.ts — Native function-calling support on the
// OpenAI-compatible base: request shape, tool_calls parsing (incl. malformed
// arguments), usage extraction, and no chat SYSTEM_PROMPT injection.
import { OpenAICompatibleAdapter, InMemoryAdapter, type NativeToolDef } from "../ai-providers";

const CAPTURED: { url: string; init: RequestInit }[] = [];
let RESPONSES: unknown[] = [];

function stubFetch() {
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
    CAPTURED.push({ url: String(url), init: init ?? {} });
    const body = RESPONSES[CAPTURED.length - 1] ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function toolDef(name: string): NativeToolDef {
  return { name, description: `${name} does things`, parameters: { type: "object", properties: {} } };
}

const TOOLS = [toolDef("read_file"), toolDef("write_file")];

function msg(body: unknown) {
  return {
    choices: [{ message: body }],
    ...(body && typeof body === "object" && "usage" in (body as Record<string, unknown>)
      ? {}
      : {}),
  };
}

beforeEach(() => {
  CAPTURED.length = 0;
  RESPONSES = [];
  stubFetch();
});

describe("OpenAICompatibleAdapter.completeWithTools", () => {
  it("sends the OpenAI tools shape, stream:false, and the caller's system message as-is", async () => {
    RESPONSES = [{ choices: [{ message: { content: "hi", tool_calls: [] } }] }];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    const out = await a.completeWithTools(
      [{ role: "system", content: "EXECUTOR PROMPT" }, { role: "user", content: "go" }],
      TOOLS,
    );
    const sent = JSON.parse(String(CAPTURED[0].init.body));
    expect(sent.tools).toHaveLength(2);
    expect(sent.tools[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
    expect(sent.stream).toBe(false);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.messages[0]).toEqual({ role: "system", content: "EXECUTOR PROMPT" });
    expect(JSON.stringify(sent.messages)).not.toContain("elite agentic coding assistant");
    expect(out.text).toBe("hi");
    expect(out.toolCalls).toEqual([]);
  });

  it("parses tool_calls with JSON-string arguments", async () => {
    RESPONSES = [{ choices: [{ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }] }];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    const out = await a.completeWithTools([{ role: "user", content: "go" }], TOOLS);
    expect(out.toolCalls).toEqual([{ name: "read_file", args: { path: "README.md" } }]);
  });

  it("degrades malformed arguments to an empty arg set, not a crash", async () => {
    RESPONSES = [{ choices: [{ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: "{broken" } }] } }] }];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    const out = await a.completeWithTools([{ role: "user", content: "go" }], TOOLS);
    expect(out.toolCalls).toEqual([{ name: "read_file", args: {} }]);
  });

  it("skips unnamed tool calls and extracts usage", async () => {
    RESPONSES = [{
      choices: [{ message: { content: "", tool_calls: [{ function: { name: "", arguments: "{}" }, id: "x" }, { function: { name: "write_file", arguments: '{"path":"a","content":"b"}' } }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    }];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    const out = await a.completeWithTools([{ role: "user", content: "go" }], TOOLS);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe("write_file");
    expect(out.usage).toEqual({ promptTokens: 120, completionTokens: 34 });
  });
});

describe("InMemoryAdapter.completeWithTools", () => {
  it("returns canned calls per user turn, then the final text", async () => {
    const a = new InMemoryAdapter(["all done"], [[{ name: "read_file", args: { path: "x" } }]]);
    const first = await a.completeWithTools([{ role: "user", content: "1" }], TOOLS);
    expect(first.toolCalls).toEqual([{ name: "read_file", args: { path: "x" } }]);
    expect(first.text).toBe("");
    const second = await a.completeWithTools([{ role: "user", content: "1" }, { role: "user", content: "2" }], TOOLS);
    expect(second.toolCalls).toEqual([]);
    expect(second.text).toBe("all done");
  });
});
