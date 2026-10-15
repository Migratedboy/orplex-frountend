import JSZip from "jszip";
import { extractedArchiveToPrompt } from "@/lib/client-attachments";

test("prompt carries the actual file contents, not just a path", () => {
  const p = extractedArchiveToPrompt("app.zip", {
    dest: "app",
    written: 2,
    skipped: 0,
    truncated: false,
    files: [
      { path: "src/index.ts", content: "export const answer = 42;" },
      { path: "README.md", content: "# demo" },
    ],
  });
  // A bare path is invisible to a cloud-run agent; the bytes must be here.
  expect(p).toContain("export const answer = 42;");
  expect(p).toContain("# demo");
  expect(p).toContain("app/src/index.ts");
  expect(p).toContain("app.zip");
});

test("notes truncation when only part of the archive is inlined", () => {
  const p = extractedArchiveToPrompt("big.zip", {
    dest: "big", written: 900, skipped: 2, truncated: true,
    files: [{ path: "a.ts", content: "x" }],
  });
  expect(p).toContain("only the first 1 readable file");
  expect(p).toContain("900 file(s)");
});

test("a real zip round-trips through extract + prompt", async () => {
  const z = new JSZip();
  z.file("src/index.ts", "export const answer = 42;");
  const buf = await z.generateAsync({ type: "nodebuffer" });
  const loaded = await JSZip.loadAsync(buf);
  const files = [];
  for (const name of Object.keys(loaded.files)) {
    const e = loaded.files[name];
    if (e.dir) continue;
    files.push({ path: name, content: await e.async("string") });
  }
  const p = extractedArchiveToPrompt("real.zip", { dest: "real", written: files.length, skipped: 0, truncated: false, files });
  expect(p).toContain("export const answer = 42;");
});
