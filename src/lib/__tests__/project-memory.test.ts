// project-memory.test.ts — orplex.md loading + token-capped rendering.
// fs is mocked; the loader's cache is cleared between tests.
jest.mock("fs/promises", () => ({ readFile: jest.fn() }));
jest.mock("fs", () => ({ existsSync: jest.fn() }));

import { loadProjectMemory, renderProjectMemory, essentialsOf, clearProjectMemoryCache, MAX_FULL_CHARS, MAX_ESSENTIALS_CHARS } from "@/lib/project-memory";
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";

const existsMock = existsSync as unknown as jest.Mock;
const readFileMock = readFile as unknown as jest.Mock;

beforeEach(() => {
  clearProjectMemoryCache();
  existsMock.mockReset();
  readFileMock.mockReset();
});

describe("loadProjectMemory", () => {
  it("loads root orplex.md and .orplex/orplex.md when present", async () => {
    existsMock.mockImplementation((p: string) => /orplex\.md$/.test(String(p)));
    readFileMock.mockImplementation(async (p: string) =>
      String(p).includes(".orplex") ? "dot rules" : "root rules"
    );

    const files = await loadProjectMemory("D:/proj");

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ source: "orplex.md", content: "root rules" });
    expect(files[1]).toEqual({ source: ".orplex/orplex.md", content: "dot rules" });
  });

  it("returns empty when no memory files exist", async () => {
    existsMock.mockReturnValue(false);
    expect(await loadProjectMemory("D:/proj")).toEqual([]);
  });

  it("skips empty files", async () => {
    existsMock.mockReturnValue(true);
    readFileMock.mockResolvedValue("   ");
    expect(await loadProjectMemory("D:/proj")).toEqual([]);
  });

  it("never throws on unreadable files", async () => {
    existsMock.mockReturnValue(true);
    readFileMock.mockRejectedValue(new Error("EACCES"));
    expect(await loadProjectMemory("D:/proj")).toEqual([]);
  });
});

describe("renderProjectMemory", () => {
  const files = [
    { source: "orplex.md", content: `# Conventions\n${"x".repeat(MAX_FULL_CHARS + 500)}` },
    { source: ".orplex/orplex.md", content: "<!-- essentials -->\nUse pnpm only.\n<!-- /essentials -->\nLong trailing content that should be excluded." },
  ];

  it("full profile truncates each file to MAX_FULL_CHARS and wraps with source", () => {
    const block = renderProjectMemory(files, "full");
    expect(block).toContain('<project_memory source="orplex.md">');
    expect(block).toContain('<project_memory source=".orplex/orplex.md">');
    expect(block.length).toBeLessThan(2 * (MAX_FULL_CHARS + 200));
  });

  it("essentials profile extracts the marked section only", () => {
    const block = renderProjectMemory(files, "essentials");
    expect(block).toContain("Use pnpm only.");
    expect(block).not.toContain("Long trailing content");
    // File 1 has no essentials marker → its head stands in (bounded).
    expect(block).toContain("# Conventions");
  });

  it("returns empty string for no files", () => {
    expect(renderProjectMemory([], "full")).toBe("");
  });
});

describe("essentialsOf", () => {
  it("falls back to the head of the file when no marker exists", () => {
    const out = essentialsOf("A".repeat(MAX_ESSENTIALS_CHARS + 999));
    expect(out.length).toBe(MAX_ESSENTIALS_CHARS);
  });

  it("prefers the marked section", () => {
    expect(essentialsOf("intro\n<!-- essentials -->THE PART<!-- /essentials -->\nrest")).toBe("THE PART");
  });
});
