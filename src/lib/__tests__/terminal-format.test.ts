/**
 * terminal-format.test.ts — ANSI stripping for terminal display.
 */
import { stripAnsi } from "../terminal-format";

describe("stripAnsi", () => {
  it("strips SGR color sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
  });

  it("strips erasure and cursor movement", () => {
    expect(stripAnsi("a\x1b[Kb")).toBe("ab");
    expect(stripAnsi("a\x1b[2Fb")).toBe("ab");
  });

  it("strips OSC hyperlinks/titles", () => {
    expect(stripAnsi("\x1b]8;;http://x\x07link\x1b]8;;\x07end")).toBe("linkend");
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello $ git status")).toBe("hello $ git status");
  });
});
