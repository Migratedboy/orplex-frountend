/**
 * [ARTIFACT] marker parsing — the live-widget channel (Gemini-style code
 * execution, client phase). The marker is ONE line of JSON; valid payloads
 * become "artifact" segments and are stripped from prose; anything malformed
 * is dropped entirely (never rendered raw), matching the [FILECARD] policy.
 */
import { parseContent, parseArtifactPayload, parseArtifactJson } from "@/lib/message-content";

const GOOD_ARTIFACT = JSON.stringify({
  title: "Ball physics",
  files: [{ name: "index.html", content: "<!DOCTYPE html><html><body>x</body></html>" }],
  controls: [{ id: "gravity", type: "slider", min: 0, max: 10, step: 0.1, value: 3, label: "Gravity" }],
});

describe("[ARTIFACT] parsing", () => {
  it("maps a valid marker to an artifact segment with the payload", () => {
    const segments = parseContent(`Here is your widget.\n[ARTIFACT]:${GOOD_ARTIFACT}\nEnjoy.`);
    expect(segments.map((s) => s.type)).toEqual(["text", "artifact", "text"]);
    expect(segments[1].artifact?.title).toBe("Ball physics");
    expect(segments[1].artifact?.files[0].name).toBe("index.html");
    expect(segments[1].artifact?.controls?.[0].value).toBe(3);
  });

  it("drops a malformed JSON marker entirely", () => {
    const segments = parseContent("text\n[ARTIFACT]:{oops\nmore");
    expect(segments.some((s) => s.type === "artifact" || s.content.includes("[ARTIFACT]"))).toBe(false);
  });

  it("drops payloads with no .html file", () => {
    const no = parseArtifactPayload({ files: [{ name: "app.js", content: "x()" }] });
    expect(no).toBeNull();
  });

  it("rejects slider with min >= max and clamp-normalizes out-of-range defaults", () => {
    expect(parseArtifactPayload({
      files: [{ name: "index.html", content: "<p/>" }],
      controls: [{ id: "a", type: "slider", min: 10, max: 0 }],
    })).toBeNull();
    const clamped = parseArtifactPayload({
      files: [{ name: "index.html", content: "<p/>" }],
      controls: [{ id: "a", type: "slider", min: 0, max: 10, value: 99 }],
    });
    expect(clamped?.controls?.[0].value).toBe(10);
  });

  it("rejects file-name junk, oversized content, and duplicate control ids", () => {
    expect(parseArtifactPayload({ files: [{ name: "../evil.js", content: "x" }] })).toBeNull();
    expect(parseArtifactPayload({ files: [{ name: "index.html", content: "x".repeat(80_001) }] })).toBeNull();
    expect(parseArtifactPayload({
      files: [{ name: "index.html", content: "<p/>" }],
      controls: [{ id: "a", type: "button" }, { id: "a", type: "button" }],
    })).toBeNull();
  });

  it("keeps a marker inside trailing prose parseable (marker must start a line)", () => {
    const segments = parseContent(`prefix [ARTIFACT]:${GOOD_ARTIFACT} inline`);
    expect(segments.map((s) => s.type)).toEqual(["text"]);
  });

  it("accepts a server block whose entry exists in files", () => {
    const parsed = parseArtifactPayload({
      files: [
        { name: "index.html", content: "<p/>" },
        { name: "main.py", content: "print('hi')" },
      ],
      server: { type: "python", entry: "main.py", port: 8000 },
    });
    expect(parsed?.server).toEqual({ type: "python", entry: "main.py", port: 8000 });
  });

  it("merges a duplicated files array instead of dropping the artifact", () => {
    // Models sometimes emit {"files":[html],"files":[py]} — JSON.parse keeps
    // only the last array, which would silently drop the HTML page.
    const raw =
      '{"title":"App","files":[{"name":"index.html","content":"<p/>"}],' +
      '"files":[{"name":"main.py","content":"print(1)"}],"server":{"type":"python","entry":"main.py"}}';
    const parsed = parseArtifactJson(raw);
    expect(parsed?.files.map((f) => f.name)).toEqual(["index.html", "main.py"]);
    expect(parsed?.server?.entry).toBe("main.py");
  });

  it("still drops payloads that stay malformed after the repair pass", () => {
    expect(parseArtifactJson('{"files":[{"name":"app.js","content":"x"}]}')).toBeNull();
    expect(parseArtifactJson("not json at all")).toBeNull();
  });

  it("rejects a server block with a missing entry, bad type, or unsafe path", () => {    const base = { files: [{ name: "index.html", content: "<p/>" }] };
    expect(parseArtifactPayload({ ...base, server: { type: "python", entry: "main.py" } })).toBeNull();
    expect(parseArtifactPayload({
      ...base,
      files: [...base.files, { name: "main.py", content: "x" }],
      server: { type: "ruby", entry: "main.py" },
    })).toBeNull();
    expect(parseArtifactPayload({
      ...base,
      files: [...base.files, { name: "main.py", content: "x" }],
      server: { type: "python", entry: "../main.py" },
    })).toBeNull();
    expect(parseArtifactPayload({
      ...base,
      files: [...base.files, { name: "main.py", content: "x" }],
      server: { type: "python", entry: "main.py", port: 99999 },
    })).toBeNull();
  });
});
