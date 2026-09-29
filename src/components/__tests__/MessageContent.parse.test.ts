/**
 * parseContent segment mapping for tool status lines.
 *
 * The worker/tools emit both [OK]/[FAIL] (read_file, run_command, …) and
 * [SUCCESS]/[ERROR] (write_file, list_files, append_file, background fixes).
 * All four prefixes must produce pill segments, not plain markdown text.
 */
import { parseContent } from "@/lib/message-content";

describe("parseContent status lines", () => {
  it("maps [SUCCESS] lines to success pill segments with the prefix stripped", () => {
    const segments = parseContent("[SUCCESS] Wrote `todo.md` (3 lines)");

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("success");
    expect(segments[0].detail).toBe("Wrote `todo.md` (3 lines)");
  });

  it("maps [ERROR] lines to error pill segments with the prefix stripped", () => {
    const segments = parseContent("[ERROR] Failed to write `todo.md`");

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("error");
    expect(segments[0].detail).toBe("Failed to write `todo.md`");
  });

  it("keeps [OK]/[FAIL] behavior unchanged", () => {
    const ok = parseContent("[OK] Read `a.ts` (lines 1–10, 41 chars)");
    expect(ok).toHaveLength(1);
    expect(ok[0].type).toBe("success");
    expect(ok[0].detail).toBe("Read `a.ts` (lines 1–10, 41 chars)");

    const fail = parseContent("[FAIL] Command failed: `npm test` (exit 1)");
    expect(fail).toHaveLength(1);
    expect(fail[0].type).toBe("error");
    expect(fail[0].detail).toBe("Command failed: `npm test` (exit 1)");
  });

  it("renders mixed content: status pills stay pills, prose stays text", () => {
    const raw = [
      "Working on it.",
      "[SUCCESS] Listed 1 file(s) in `.`",
      "Now writing the file.",
      "[OK] Read `todo.md` (lines 1-1, 41 chars)",
    ].join("\n");

    const segments = parseContent(raw);

    expect(segments.map((s) => s.type)).toEqual(["text", "success", "text", "success"]);
  });

  it("does not treat the bracket word in prose as a status line", () => {
    const segments = parseContent("The [SUCCESS] keyword is just text here.");

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("text");
  });
});
