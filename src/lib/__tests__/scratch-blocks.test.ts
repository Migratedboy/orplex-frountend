/**
 * scratch-blocks.test.ts — Scratch panel parsing + change detection.
 */
import { parseScratchBlocks, changedHeads } from "../scratch-blocks";

describe("parseScratchBlocks", () => {
  it("splits known sections into blocks", () => {
    const text = ["<scratchpad>", "plan: Reproduce the failure", "hypotheses: schema rejected", "findings: route 500s", "next: rerun tests", "</scratchpad>"].join("\n");
    const blocks = parseScratchBlocks(text);
    expect(blocks.map((b) => b.head)).toEqual(["plan", "hypotheses", "findings", "next"]);
    expect(blocks[2].body).toBe("route 500s");
  });

  it("folds continuation lines into the current block", () => {
    const blocks = parseScratchBlocks("findings: line one\nline two\nnext: go");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].body).toBe("line one\nline two");
  });

  it("ignores preamble lines before the first heading", () => {
    const blocks = parseScratchBlocks("random chatter\nplan: ok");
    expect(blocks).toEqual([{ head: "plan", body: "ok" }]);
  });

  it("does not treat capitalised prose 'Error:' as a heading", () => {
    const blocks = parseScratchBlocks("findings: backend broke\nError: the handler threw");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toContain("Error: the handler threw");
  });

  it("accepts a generic second heading section", () => {
    const blocks = parseScratchBlocks("plan: ok\nnotes: remember this");
    expect(blocks.map((b) => b.head)).toEqual(["plan", "notes"]);
  });

  it("accepts 'next steps' as a heading", () => {
    const blocks = parseScratchBlocks("next steps: run typecheck");
    expect(blocks[0].head).toBe("next steps");
  });

  it("returns [] for empty text", () => {
    expect(parseScratchBlocks("")).toEqual([]);
    expect(parseScratchBlocks("<scratchpad>\n</scratchpad>")).toEqual([]);
  });
});

describe("changedHeads", () => {
  it("pulses the last block on the first render", () => {
    const cur = [{ head: "plan", body: "a" }, { head: "findings", body: "b" }];
    expect(changedHeads([], cur)).toEqual(new Set(["findings"]));
  });

  it("reports only heads whose body changed", () => {
    const prev = [{ head: "plan", body: "a" }, { head: "findings", body: "b" }];
    const next = [{ head: "plan", body: "a" }, { head: "findings", body: "b2" }];
    expect(changedHeads(prev, next)).toEqual(new Set(["findings"]));
  });

  it("reports newly appeared heads and empty when nothing changed", () => {
    const prev = [{ head: "plan", body: "a" }];
    const next = [{ head: "plan", body: "a" }, { head: "next", body: "go" }];
    expect(changedHeads(prev, next)).toEqual(new Set(["next"]));
    expect(changedHeads(prev, prev)).toEqual(new Set());
  });
});
