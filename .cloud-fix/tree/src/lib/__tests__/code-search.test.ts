/**
 * code_search (snippet mode) — grouped per-file snippets + read_file hints.
 * Covers: parse of rg raw output (with "--" group separators), hint math,
 * per-file match caps, output byte cap, no-match output, and hint correctness
 * (offset never below 1).
 */
import { codeSearch } from "../grep-search";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "code-search-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "invoice.ts"),
    [
      "// invoice.ts — billing",
      "export function calculateInvoiceTotal(net: number): number {",
      "  const vat = net * 0.19; // BUG: hardcoded VAT rate",
      "  return net + vat;",
      "}",
      "",
      "export function refund(net: number): number {",
      "  return -net;",
      "}",
      "",
      "export function legacyVat(net: number): number {",
      "  const vat = net * 0.19; // BUG: duplicated here",
      "  return net + vat;",
      "}",
    ].join("\n") + "\n"
  );
  await writeFile(
    path.join(root, "src", "other.ts"),
    "export const vatNote = 'hardcoded VAT rate example';\n"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function extractHints(output: string): string[] {
  return output.split("\n").filter((l) => l.includes("→ read_file"));
}

describe("codeSearch", () => {
  it("returns grouped per-file sections with headers", async () => {
    const res = await codeSearch(root, "hardcoded VAT rate");
    expect(res).not.toBeNull();
    expect(res!.engine).toBe("ripgrep");
    expect(res!.output).toContain("## src/invoice.ts");
    expect(res!.output).toContain("## src/other.ts");
    expect(res!.matchCount).toBe(2);
  }, 30_000);

  it("annotates each match with a read_file hint whose window covers the match", async () => {
    const res = await codeSearch(root, "hardcoded VAT rate");
    const hints = extractHints(res!.output);
    expect(hints.length).toBe(2);
    // Match at line 3 (top-area) → offset = max(1, 3-3) = 1, never 0/negative
    expect(hints.join("\n")).toMatch(/offset=1 limit=11/);
  }, 30_000);

  it("computes mid-file hint offsets from the match line", async () => {
    // Self-sufficient fixture: a match on line 12 → offset = 12-3 = 9
    await writeFile(
      path.join(root, "src", "midfile.ts"),
      Array.from({ length: 11 }, () => "// filler").concat("export const marker = \"midfile-target\";").join("\n") + "\n"
    );
    const res = await codeSearch(root, "midfile-target");
    expect(res!.output).toMatch(/offset=9 limit=11/);
  }, 30_000);

  it("shows the matching line text with its line number", async () => {
    const res = await codeSearch(root, "hardcoded VAT rate");
    expect(res!.output).toContain("src/invoice.ts:3:");
    expect(res!.output).toContain("vat = net * 0.19");
  }, 30_000);

  it("returns a clean no-match result", async () => {
    const res = await codeSearch(root, "definitely-not-present-xyz");
    expect(res).not.toBeNull();
    expect(res!.output).toContain('No matches for "definitely-not-present-xyz"');
    expect(res!.matchCount).toBe(0);
  }, 30_000);

  it("caps matches per file at 5 with an ellipsis note", async () => {
    // many repeated matches in one file
    const many = Array.from({ length: 12 }, (_, i) => `export const hit${i} = "needle-here";`).join("\n");
    await writeFile(path.join(root, "src", "many.ts"), many + "\n");
    const res = await codeSearch(root, "needle-here");
    expect(res!.output).toContain("## src/many.ts (12 matches)");
    expect(res!.output).toContain("more match(es) in this file");
  }, 30_000);

  it("handles regex mode", async () => {
    const res = await codeSearch(root, "vat \\* net \\* 0\\.19", { isRegex: false });
    // literal — escaped form should not match anything in literal mode
    expect(res!.matchCount).toBe(0);
    const res2 = await codeSearch(root, "net \\* 0\\.19", { isRegex: true });
    expect(res2!.matchCount).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
