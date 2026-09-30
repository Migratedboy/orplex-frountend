// mid-stream-fallback.test.ts — When a selected model dies mid-response or
// every provider fails, the user must get an honest notice in the chat bubble
// instead of an empty response with a dead spinner.
//
// Covers:
//   1. watchMidStreamFailure — in-stream error object arriving AFTER the
//      ladder's 8-chunk peek window → the stream becomes a notice + [DONE].
//   2. watchMidStreamFailure — degenerate single-char flood forming late →
//      notice stream.
//   3. watchMidStreamFailure — healthy deltas flow through untouched.
//   4. sseNoticeChunk — client-shaped payload.

import { watchMidStreamFailure, sseNoticeChunk } from "../chat-middleware";

const enc = new TextEncoder();

function sseStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

const deltaLine = (d: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("watchMidStreamFailure — honest notice instead of an empty bubble", () => {
  it("replaces the stream with a notice when an in-stream error object arrives mid-stream", async () => {
    const upstream = sseStream([
      deltaLine({ content: "Partial answer that looked healthy " }),
      deltaLine({ content: "so far " }),
      `data: ${JSON.stringify({ error: { message: "ResourceExhausted: worker limit reached" } })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const out = await readAll(watchMidStreamFailure("nvidia-test", upstream));

    // The healthy deltas BEFORE the failure still reached the client (they
    // were enqueued as they arrived), and the stream ends with the notice.
    expect(out).toContain("Partial answer");
    expect(out).toContain("stopped mid-response");
    expect(out).toContain("ResourceExhausted");
    expect(out).toContain("Send again or pick another model");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("replaces the stream with a notice when a degenerate flood forms late", async () => {
    const parts = [
      deltaLine({ reasoning_content: "thinking normally " }),
      deltaLine({ reasoning_content: "still fine " }),
    ];
    // 24 single-"!" deltas — past the flood threshold only AFTER the peek.
    for (let i = 0; i < 26; i++) parts.push(deltaLine({ reasoning_content: "!" }));
    const out = await readAll(watchMidStreamFailure("kimi-cold", sseStream(parts)));

    expect(out).toContain("stopped mid-response");
    expect(out).toContain("degenerate output");
    expect(out).toContain("Send again or pick another model");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("passes a healthy stream through untouched (no notice injected)", async () => {
    const upstream = sseStream([
      deltaLine({ reasoning_content: "Some real reasoning. " }),
      deltaLine({ content: "Hello" }),
      deltaLine({ content: " world" }),
      "data: [DONE]\n\n",
    ]);

    const out = await readAll(watchMidStreamFailure("groq-test", upstream));

    expect(out).toContain("Some real reasoning.");
    expect(out).toContain("Hello");
    expect(out).toContain(" world");
    expect(out).not.toContain("stopped mid-response");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("survives a network drop mid-stream without throwing", async () => {
    // Chunk delivered, THEN the transport dies — the watcher must have
    // already passed the first chunk through and close without a notice.
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(deltaLine({ content: "chunk one " })));
        setTimeout(() => c.error(new Error("network reset")), 10);
      },
    });
    const out = await readAll(watchMidStreamFailure("drop-test", upstream));
    expect(out).toContain("chunk one ");
    // No fake "stopped mid-response" claim on a transport error — the client
    // already knows the stream died.
    expect(out).not.toContain("stopped mid-response");
  });
});

describe("sseNoticeChunk", () => {
  it("produces a client-shaped content event", () => {
    const text = new TextDecoder().decode(sseNoticeChunk("hello notice"));
    expect(text).toMatch(/^data: \{"content":"hello notice"\}\n\n$/);
  });
});
