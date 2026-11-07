// ai-providers-native-tools.test.ts — Native function-calling support on the
// OpenAI-compatible base: request shape, tool_calls parsing (incl. malformed
// arguments), usage extraction, and no chat SYSTEM_PROMPT injection.
//
// The transient-blip ladder is pinned here too (LIVE FAIL reproduced): the
// adapter used `attempts: 2`, so a provider HTTP 500 on the model call behind
// tool call #2 killed the whole agent run after ONE retry, while /api/chat
// rode the same blip out 20 deep. The ladder is now shared.
import { OpenAICompatibleAdapter, InMemoryAdapter, type NativeToolDef } from "../ai-providers";
import { PROVIDER_LADDER } from "../retry";

const CAPTURED: { url: string; init: RequestInit }[] = [];
let RESPONSES: unknown[] = [];

/** A raw non-ok provider answer: when placed in RESPONSES, the fetch stub
 *  returns it as-is (adapter sees ok:false). `retry-after: 0` in the body is
 *  a zero-delay Retry-After hint the ladder honors — full attempt speed with
 *  no fake timers. */
const errorStub = (status: number, bodyText = "upstream unavailable") => ({
  __orplexHttpError: true,
  ok: false,
  status,
  json: async () => ({}),
  text: async () => bodyText,
});

function stubFetch() {
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
    CAPTURED.push({ url: String(url), init: init ?? {} });
    const body = RESPONSES[CAPTURED.length - 1] ?? {};
    if ((body as { __orplexHttpError?: boolean })?.__orplexHttpError === true) {
      return body as unknown as Response;
    }
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

describe("OpenAICompatibleAdapter transient-blip ladder (run parity with /api/chat)", () => {
  // Tests ride a zero-delay Retry-After hint (see errorStub) so the real
  // ladder's backoff never sleeps the suite.
  const fast500 = () => errorStub(500, "upstream unavailable retry-after: 0");

  it("retries a transient 500 mid-run and completes the tool-call turn", async () => {
    RESPONSES = [
      fast500(), // tool call #2's first attempt — the LIVE FAIL from the field
      { choices: [{ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: "{}" } }] } }] },
    ];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    const out = await a.completeWithTools([{ role: "user", content: "go" }], TOOLS);
    expect(out.toolCalls).toEqual([{ name: "read_file", args: {} }]);
    expect(CAPTURED.length).toBe(2); // 1 failed attempt + 1 successful retry
  });

  it("does NOT retry a permanent 400 — fails on the first attempt", async () => {
    RESPONSES = [errorStub(400, "malformed request"), ...Array.from({ length: PROVIDER_LADDER.attempts - 1 }, fast500)];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    await expect(a.completeWithTools([{ role: "user", content: "go" }], TOOLS))
      .rejects.toThrow(/LLM API error: 400/);
    expect(CAPTURED.length).toBe(1); // immediate rethrow — no burned budget
  });

  it("climbs the FULL ladder (20 attempts) when the provider keeps 500-ing", async () => {
    RESPONSES = Array.from({ length: PROVIDER_LADDER.attempts }, fast500);
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    await expect(a.completeWithTools([{ role: "user", content: "go" }], TOOLS))
      .rejects.toThrow(/LLM API error: 500/);
    expect(CAPTURED.length).toBe(PROVIDER_LADDER.attempts); // every rung, not 2
  });

  it("the stream transport rides the same ladder instead of dying instantly", async () => {
    RESPONSES = [fast500(), { choices: [{ delta: { content: "hi" } }] }];
    const a = new OpenAICompatibleAdapter({ name: "test", apiKey: "k", model: "m", baseUrl: "https://x.test/v1" });
    // stream() only fetches + peeks the status — the returned body is opaque.
    const body = await a.stream([{ role: "user", content: "go" }]);
    expect(body).not.toBeNull();
    expect(CAPTURED.length).toBe(2);
  });
});
