/**
 * message-retry.test.ts — The one-click Retry flow on failed assistant
 * messages rests on three pure pieces:
 *   1. stampFailedMessage / isFailedMessage — the [FAILED] marker written at
 *      failure time and read by the renderer.
 *   2. readFailedMeta — the base64 meta payload round-trips exactly (mode /
 *      effort / model / files / images), survives markdown-mangling chars,
 *      and degrades to null instead of throwing on garbage.
 *   3. findFailedExchange — retry resolves the bubble's OWN preceding user
 *      prompt (backward search, never a newer exchange), with meta
 *      recovered from the assistant stamp or the user row.
 */
import {
  stampFailedMessage,
  isFailedMessage,
  readFailedMeta,
  findFailedExchange,
  userTypedText,
  FAILED_MARKER,
  type FailedMeta,
} from "../message-retry";
import type { Message } from "@/hooks/useMessages";

function msg(role: "user" | "assistant", content: string, extra: Partial<Message> = {}): Message {
  return { role, content, time: "10:00", ...extra };
}

describe("stampFailedMessage / isFailedMessage", () => {
  it("appends the marker to trimmed content", () => {
    const out = stampFailedMessage("partial answer\n");
    expect(out).toBe(`partial answer\n${FAILED_MARKER}`);
    expect(isFailedMessage(out)).toBe(true);
  });

  it("stamps empty failed bubbles too (server notice stream cases)", () => {
    const out = stampFailedMessage("");
    expect(out).toBe(FAILED_MARKER);
    expect(isFailedMessage(out)).toBe(true);
  });

  it("does not flag normal or interrupted messages", () => {
    expect(isFailedMessage("A perfectly good answer.")).toBe(false);
    expect(isFailedMessage("partial\n[INTERRUPTED]")).toBe(false);
    expect(isFailedMessage(undefined)).toBe(false);
    expect(isFailedMessage(null)).toBe(false);
  });

  it("only counts the marker on its own line basis", () => {
    // Inline occurrences in body text must not arm the Retry button.
    expect(isFailedMessage("the spec says [FAILED] somewhere")).toBe(false);
    expect(isFailedMessage("the spec says\n[FAILED] somewhere")).toBe(false);
  });
});

describe("readFailedMeta", () => {
  it("round-trips the full meta payload", () => {
    const meta: FailedMeta = {
      mode: "code",
      effort: "high",
      model: "vendor/m1",
      files: [{ name: "a.ts", content: "const x = 1;", size: 13 }],
      images: [{ name: "shot.png", dataUrl: "data:image/png;base64,AAA=", size: 99 }],
    };
    const stamped = stampFailedMessage("boom", meta);
    expect(readFailedMeta(stamped)).toEqual(meta);
  });

  it("handles multiline file content and unicode via base64", () => {
    const meta: FailedMeta = {
      mode: "ask",
      files: [{ name: "b.md", content: "# heading\n\n```js\nconst café = 'ok';\n```\n", size: 40 }],
    };
    expect(readFailedMeta(stampFailedMessage("x", meta))).toEqual(meta);
  });

  it("returns null when no meta was stamped or payload is garbage", () => {
    expect(readFailedMeta(FAILED_MARKER)).toBeNull();
    expect(readFailedMeta(`${FAILED_MARKER}\n[FAILED_META]:%%%not-base64%%%`)).toBeNull();
    const bad = stampFailedMessage("x", { mode: "ask" }).replace(
      /\[FAILED_META\]:.*/,
      // Valid base64 that decodes to non-JSON.
      `[FAILED_META]:${Buffer.from("not json", "utf8").toString("base64")}`,
    );
    expect(readFailedMeta(bad)).toBeNull();
  });

  it("omits the meta line entirely for an empty meta object", () => {
    expect(stampFailedMessage("x", {})).toBe(`x\n${FAILED_MARKER}`);
    expect(readFailedMeta(stampFailedMessage("x", {}))).toBeNull();
  });
});

describe("findFailedExchange", () => {
  it("pairs the bubble with its own preceding user prompt and meta", () => {
    const meta: FailedMeta = { mode: "code", model: "vendor/m1" };
    const messages = [
      msg("user", "earlier question"),
      msg("assistant", "earlier answer"),
      msg("user", "do the thing"),
      msg("assistant", stampFailedMessage("partial…", meta)),
    ];
    const found = findFailedExchange(messages, 3);
    expect(found).not.toBeNull();
    expect(found!.user.content).toBe("do the thing");
    expect(found!.meta).toEqual(meta);
  });

  it("tolerates a worker-stamped bubble with no meta (null, caller falls back)", () => {
    const messages = [
      msg("user", "do the thing"),
      msg("assistant", FAILED_MARKER),
    ];
    const found = findFailedExchange(messages, 1);
    expect(found).not.toBeNull();
    expect(found!.meta).toBeNull();
    expect(found!.user.content).toBe("do the thing");
  });

  it("returns null for non-failed, non-assistant, or out-of-range rows", () => {
    const messages = [
      msg("user", "q"),
      msg("assistant", "normal answer"),
      msg("user", "q2"),
    ];
    expect(findFailedExchange(messages, 1)).toBeNull(); // not failed
    expect(findFailedExchange(messages, 2)).toBeNull(); // not assistant
    expect(findFailedExchange(messages, 9)).toBeNull(); // out of range
    expect(findFailedExchange(messages, -1)).toBeNull();
  });

  it("rejects a failed bubble with no preceding user message", () => {
    expect(findFailedExchange([msg("assistant", stampFailedMessage("x"))], 0)).toBeNull();
  });
});

describe("userTypedText", () => {
  it("extracts the typed prompt from the buildM3Context wrapper", () => {
    const wrapped = "[WORKSPACE: orplex]\nDirectory:\nsrc/…\n\nUser request: build the login page";
    expect(userTypedText(wrapped)).toBe("build the login page");
  });

  it("returns plain content untouched", () => {
    expect(userTypedText("just a prompt")).toBe("just a prompt");
    expect(userTypedText("")).toBe("");
  });
});
