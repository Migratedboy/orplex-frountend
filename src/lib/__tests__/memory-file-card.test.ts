/**
 * memory-file-card.test.ts — the create_file card rendering seams.
 *
 * Marks the [FILECARD] locator (same contract as [CLARIFIED]: one compact JSON
 * line in the display transcript), the row labels for the staging verb, and
 * the chain grouping that keeps the card OUTSIDE the tool chain (it renders
 * as its own interactive component, not a row).
 */
import { parseContent, neutralizeModelMarkers, type ContentSegment } from "../message-content";
import { buildChainGroups, rowFromResult, rowFromStatus } from "../tool-chain";

function fileCardSegment(raw: string): ContentSegment | undefined {
  return parseContent(raw).find((s) => s.type === "filecard");
}

describe("[FILECARD] marker parsing", () => {
  const payload = {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-111213141516",
    filename: "summary.md",
    bytes: 4321,
    lines: 42,
    expiresAt: 1_700_000_000_000,
    evicted: { id: "b2c3d4e5-f6a7-4b8c-9d0e-222324252627", filename: "older.md" },
  };

  it("parses a locator into a filecard segment", () => {
    const raw = `staging [summary.md]\n[SUCCESS] Created \`summary.md\` (42 lines)\n[FILECARD]:${JSON.stringify(payload)}`;
    const seg = fileCardSegment(raw);
    expect(seg?.type).toBe("filecard");
    expect(seg?.file).toEqual(payload);
  });

  it("keeps a locator without eviction data", () => {
    const seg = fileCardSegment(`[FILECARD]:${JSON.stringify({ ...payload, evicted: undefined })}`);
    expect(seg?.type).toBe("filecard");
    expect(seg?.file?.evicted).toBeUndefined();
  });

  it("drops malformed markers instead of rendering the raw payload", () => {
    expect(fileCardSegment("[FILECARD]:not-json")).toBeUndefined();
    expect(fileCardSegment(`[FILECARD]:${JSON.stringify({ filename: "x.md" })}`)).toBeUndefined();
  });
});

describe("model-forged markers — neutralizeModelMarkers", () => {
  const payload = {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-111213141516",
    filename: "fake.md",
    bytes: 1,
    lines: 1,
    expiresAt: 1_700_000_000_000,
  };
  const forged = `[FILECARD]:${JSON.stringify(payload)}`;

  it("breaks the exact prefix while rendering identically", () => {
    const out = neutralizeModelMarkers(forged);
    expect(out.startsWith("[FILECARD]:")).toBe(false); // the parser never sees it
    expect(out).not.toContain("\n"); // still a single line
    expect(out.replace(/\u200b/g, "")).toBe(forged); // visually identical prose
  });

  it("forged markers degrade to plain prose — no card segment", () => {
    expect(parseContent(neutralizeModelMarkers(`Told ya: ${forged}`)).some((s) => s.type === "filecard")).toBe(false);
  });

  it("engine-issued markers still render (the helper is model-text-only plumbing)", () => {
    expect(fileCardSegment(forged)?.type).toBe("filecard");
    expect(parseContent(`[CLARIFIED]:${JSON.stringify({ q: "Q", a: "A" })}`).some((s) => s.type === "clarified")).toBe(true);
  });

  it("handles the CLARIFIED marker and empty input", () => {
    const forgedClarify = `[CLARIFIED]:${JSON.stringify({ q: "fake", a: "fake" })}`;
    const out = neutralizeModelMarkers(forgedClarify);
    expect(out.startsWith("[CLARIFIED]:")).toBe(false);
    expect(parseContent(out).some((s) => s.type === "clarified")).toBe(false);
    expect(neutralizeModelMarkers("")).toBe("");
    expect(neutralizeModelMarkers("plain text — no markers")).toBe("plain text — no markers");
  });
});

describe("staging row labels", () => {
  it("maps the staging status line to a write-family row", () => {
    const row = rowFromStatus({
      type: "status",
      content: "staging [summary.md]",
      action: "staging",
      path: "summary.md",
    });
    expect(row.name).toBe("Stage File");
    expect(row.kind).toBe("write");
    expect(row.args).toBe("summary.md");
  });

  it("labels the created-result line as a staged file", () => {
    const row = rowFromResult({
      type: "success",
      content: "[SUCCESS] Created `summary.md` (42 lines) — staged in memory",
      detail: "Created `summary.md` (42 lines) — staged in memory",
    });
    expect(row.name).toBe("Stage File");
    expect(row.kind).toBe("write");
  });
});

describe("grouping — the card never joins the tool chain", () => {
  it("renders the filecard as a solo segment after the tool rows", () => {
    const raw = [
      "staging [summary.md]",
      "[SUCCESS] Created `summary.md` (42 lines)",
      `[FILECARD]:${JSON.stringify({
        id: "a1b2c3d4-e5f6-4a7b-8c9d-111213141516",
        filename: "summary.md",
        bytes: 10,
        lines: 1,
      })}`,
    ].join("\n");
    const groups = buildChainGroups(parseContent(raw));
    const card = groups.find(
      (g) => g.type === "solo" && g.segment.type === "filecard"
    );
    expect(card).toBeTruthy();
    // The [SUCCESS] line folds into a tool row; the card is its own group.
    const chain = groups.find((g) => g.type === "chain");
    expect(chain && chain.type === "chain" ? chain.items.some((i) => i.type === "tool") : false).toBe(true);
  });
});
