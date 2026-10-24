/**
 * Artifact sandbox payload validation — the server NEVER trusts the client
 * render path: the same caps are enforced again here before anything is
 * uploaded to a Vercel Sandbox VM.
 */
import { parseArtifactPayload } from "@/lib/artifact-sandbox";

describe("parseArtifactPayload", () => {
  const base = {
    files: [
      { path: "index.html", content: "<p/>" },
      { path: "main.py", content: "print('hi')" },
    ],
    entry: "main.py",
    language: "python",
  };

  it("accepts a well-formed payload", () => {
    const parsed = parseArtifactPayload(base);
    expect(parsed.ok).toBe(true);
    expect(parsed.artifact?.files).toHaveLength(2);
    expect(parsed.artifact?.entry).toBe("main.py");
  });

  it("rejects unknown languages, empty file lists, and oversized payloads", () => {
    expect(parseArtifactPayload({ ...base, language: "ruby" }).ok).toBe(false);
    expect(parseArtifactPayload({ ...base, files: [] }).ok).toBe(false);
    const huge = { ...base, files: [{ path: "index.html", content: "x".repeat(80_001) }] };
    expect(parseArtifactPayload(huge).ok).toBe(false);
  });

  it("rejects path traversal and entries that are not in the file list", () => {
    expect(parseArtifactPayload({ ...base, files: [{ path: "../evil.py", content: "x" }], entry: "evil.py" }).ok).toBe(false);
    expect(parseArtifactPayload({ ...base, entry: "missing.py" }).ok).toBe(false);
    expect(parseArtifactPayload({ ...base, entry: "../main.py" }).ok).toBe(false);
  });

  it("rejects more than 25 files", () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ path: `f${i}.html`, content: "x" }));
    expect(parseArtifactPayload({ ...base, files: many, entry: "f0.html" }).ok).toBe(false);
  });
});
