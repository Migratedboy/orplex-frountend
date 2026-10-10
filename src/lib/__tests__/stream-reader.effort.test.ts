/**
 * stream-reader.effort.test.ts — Contract test for the effort field.
 *
 * The effort slider (Low/Medium/High) must survive the whole chain down to
 * the server. These tests assert that `readStream` includes the `effort`
 * field in the JSON body of its POST to /api/chat:
 *
 *   1. effort passed  → body.effort is the exact string
 *   2. effort omitted → body.effort is undefined (server default kicks in)
 *   3. full worker path: runInBackground(..., effort) forwards it too
 *
 * The server side (zod schema) accepts any casing and normalizes to
 * lowercase — covered by validators.test.ts; here we pin the client side.
 */
import { readStream } from "../stream-reader";
import { runInBackground } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { delay, waitFor } from "./helpers";

/** Minimal SSE stream in the shape /api/chat returns (see abort-flow.test.ts). */
function sseBody(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const word of content.split(" ")) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: word + " " })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Captures the parsed JSON bodies of every POST to /api/chat. */
function mockChatApi() {
  const chatBodies: Record<string, unknown>[] = [];
  const originalFetch = global.fetch;

  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      chatBodies.push(body);
      return Promise.resolve(
        new Response(sseBody("ok"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  return {
    chatBodies,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

describe("readStream effort contract", () => {
  const callbacks = { onChunk: () => {}, onThinking: () => {} };
  let api: ReturnType<typeof mockChatApi>;

  beforeEach(() => {
    api = mockChatApi();
  });

  afterEach(() => {
    api.restore();
  });

  it("includes effort in the POST body when provided", async () => {
    await readStream(
      [{ role: "user", content: "hi" }],
      null,
      callbacks,
      "ask",
      [],
      null,
      "high"
    );

    expect(api.chatBodies).toHaveLength(1);
    expect(api.chatBodies[0].effort).toBe("high");
  });

  it("forwards every effort level verbatim", async () => {
    for (const effort of ["low", "medium", "high"]) {
      await readStream([{ role: "user", content: "hi" }], null, callbacks, "ask", [], null, effort);
      expect(api.chatBodies[api.chatBodies.length - 1].effort).toBe(effort);
    }
    expect(api.chatBodies).toHaveLength(3);
  });

  it("omits the effort field when none is given (server default)", async () => {
    await readStream([{ role: "user", content: "hi" }], null, callbacks, "ask", [], null);

    expect(api.chatBodies).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(api.chatBodies[0], "effort")
    ).toBe(false);
  });

  it("sends effort alongside mode without disturbing the rest of the body", async () => {
    await readStream(
      [{ role: "user", content: "build it" }],
      "conv-123",
      callbacks,
      "code",
      [],
      null,
      "low"
    );

    const body = api.chatBodies[0];
    expect(body.effort).toBe("low");
    expect(body.mode).toBe("code");
    expect(body.conversationId).toBe("conv-123");
    expect(body.messages).toEqual([{ role: "user", content: "build it" }]);
  });
});

describe("runInBackground effort forwarding", () => {
  let api: ReturnType<typeof mockChatApi>;

  beforeEach(() => {
    api = mockChatApi();
  });

  afterEach(() => {
    api.restore();
    try {
      if (getCurrentTask()) abortCurrentTask();
    } catch {}
  });

  it("forwards the worker's effort argument into the /api/chat body", async () => {
    const run = runInBackground("say ok", null, [], "ask", [], undefined, "high");
    await waitFor(() => api.chatBodies.length > 0);
    await run;

    expect(api.chatBodies[0].effort).toBe("high");
    expect(api.chatBodies[0].mode).toBe("ask");
  });

  it("leaves effort unset when the worker is called without one", async () => {
    const run = runInBackground("say ok", null, [], "ask", []);
    await waitFor(() => api.chatBodies.length > 0);
    await run;
    // Give the worker a beat to settle, then stop any lingering task.
    await delay(50);
    abortCurrentTask();

    expect(
      Object.prototype.hasOwnProperty.call(api.chatBodies[0], "effort")
    ).toBe(false);
  });
});

describe("readStream model contract", () => {
  const callbacks = { onChunk: () => {}, onThinking: () => {} };
  let api: ReturnType<typeof mockChatApi>;

  beforeEach(() => {
    api = mockChatApi();
  });

  afterEach(() => {
    api.restore();
  });

  it("includes the picked model in the POST body when provided", async () => {
    await readStream(
      [{ role: "user", content: "hi" }],
      null,
      callbacks,
      "ask",
      [],
      null,
      "medium",
      "full",
      { model: "qwen/qwen3.8-27b:free" }
    );

    expect(api.chatBodies).toHaveLength(1);
    expect(api.chatBodies[0].model).toBe("qwen/qwen3.8-27b:free");
  });

  it("omits the model field when none is given (server auto-routing)", async () => {
    await readStream([{ role: "user", content: "hi" }], null, callbacks, "ask");

    expect(api.chatBodies).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(api.chatBodies[0], "model")
    ).toBe(false);
  });

  it("forwards the worker's opts.model into the /api/chat body", async () => {
    const run = runInBackground("say ok", null, [], "ask", [], undefined, undefined, {
      model: "openai/gpt-oss-120b",
    });
    await waitFor(() => api.chatBodies.length > 0);
    await run;

    expect(api.chatBodies[0].model).toBe("openai/gpt-oss-120b");
  });
});
