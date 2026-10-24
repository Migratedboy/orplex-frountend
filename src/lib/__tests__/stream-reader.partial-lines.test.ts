/**
 * stream-reader.partial-lines.test.ts — SSE event boundaries do NOT align
 * with network chunk boundaries.
 *
 * A network chunk can end mid-JSON ("data: {\"content\":\"hel"). The old
 * reader split each chunk into lines and JSON.parse'd every "data: " line —
 * so both halves of a split event were silently dropped:
 *   - streamed answer text lost deltas (corrupted/gappy answers);
 *   - truncated native tool_call argument fragments never reassembled, so
 *     the parser threw the whole call away and the task died as an
 *     "empty response" with no tool executed.
 *
 * The fix buffers the incomplete tail until the next chunk (same discipline
 * as the server's sseTransform). These tests feed deliberately SPLIT bytes
 * and assert nothing is lost.
 */
import { readStream } from "../stream-reader";

const encoder = new TextEncoder();

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function mockChatApi(body: ReadableStream<Uint8Array>): void {
  (global.fetch as unknown) = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
  }) as typeof fetch;
}

afterEach(() => {

  jest.restoreAllMocks();
});

describe("readStream partial-line buffering", () => {
  it("reassembles a content event split mid-JSON across two chunks", async () => {
    const ev1 = `data: ${JSON.stringify({ content: "Hello " })}\n\n`;
    const ev2 = `data: ${JSON.stringify({ content: "world" })}\n\n`;
    const raw = ev1 + ev2;
    // Split raw exactly in the middle of ev2's JSON payload.
    const cut = ev1.length + 10;
    mockChatApi(
      streamFromChunks([encoder.encode(raw.slice(0, cut)), encoder.encode(raw.slice(cut))])
    );

    const chunks: string[] = [];
    const result = await readStream(
      [{ role: "user", content: "hi" }],
      null,
      { onChunk: (c) => chunks.push(c) },
      "ask"
    );

    expect(result.content).toBe("Hello world");
    expect(chunks[chunks.length - 1]).toBe("Hello world");
  });

  it("reassembles tool_call argument fragments split across chunks", async () => {
    // One native tool call whose arguments JSON arrives in three fragments,
    // each later split mid-payload across network chunks.
    const mk = (args: string) => `data: ${JSON.stringify({ tool_calls: [{ index: 0, function: { name: "write_file", arguments: args } }] })}\n\n`;
    const raw = mk('{"pa') + mk('th": "a.') + mk('txt", "content": "x"}') + "data: [DONE]\n\n";
    // Split after every byte-ish boundary inside the middle event.
    const chunks: Uint8Array[] = [];
    let i = 0;
    while (i < raw.length) {
      const step = 7; // arbitrary small size — lands mid-JSON almost always
      chunks.push(encoder.encode(raw.slice(i, i + step)));
      i += step;
    }
    mockChatApi(streamFromChunks(chunks));

    const result = await readStream(
      [{ role: "user", content: "hi" }],
      null,
      { onChunk: () => {} },
      "code"
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write_file");
    expect(result.toolCalls[0].path).toBe("a.txt");
    expect(result.toolCalls[0].content).toBe("x");
  });

  it("passes create_file's filename argument through the native arg allowlist", async () => {
    // create_file is a NEW tool whose args ride the same allowlist — before
    // the fix, `filename` was missing from TOOL_ARG_FIELDS and the parser
    // silently dropped it, so dispatch fell through to "not available here".
    const raw =
      `data: ${JSON.stringify({ tool_calls: [{ index: 0, function: { name: "create_file", arguments: '{"filename": "summary.md", "content": "# hi"}' } }] })}\n\n` +
      "data: [DONE]\n\n";
    mockChatApi(streamFromChunks([encoder.encode(raw)]));

    const result = await readStream(
      [{ role: "user", content: "hi" }],
      null,
      { onChunk: () => {} },
      "code"
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("create_file");
    expect(result.toolCalls[0].filename).toBe("summary.md");
    expect(result.toolCalls[0].content).toBe("# hi");
  });

  it("processes a final event that lacks its trailing newline", async () => {
    const raw = `data: ${JSON.stringify({ content: "tail" })}\n\ndata: ${JSON.stringify({ content: " end" })}`;
    mockChatApi(streamFromChunks([encoder.encode(raw)]));

    const result = await readStream(
      [{ role: "user", content: "hi" }],
      null,
      { onChunk: () => {} },
      "ask"
    );

    expect(result.content).toBe("tail end");
  });

  it("handles multi-byte UTF-8 split across chunk boundaries", async () => {
    const text = "héllo wörld — ünïcode ✓";
    const raw = `data: ${JSON.stringify({ content: text })}\n\n`;
    const bytes = encoder.encode(raw);
    // Split at a byte offset that lands inside a multi-byte sequence.
    const cut = bytes.length - 6;
    mockChatApi(streamFromChunks([bytes.slice(0, cut), bytes.slice(cut)]));

    const result = await readStream(
      [{ role: "user", content: "hi" }],
      null,
      { onChunk: () => {} },
      "ask"
    );

    expect(result.content).toBe(text);
  });
});
