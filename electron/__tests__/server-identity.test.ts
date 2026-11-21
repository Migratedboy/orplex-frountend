/**
 * The identity check exists to stop the app loading an OLD server: a zombie
 * from a previous version answers the port probe, so liveness is not enough.
 * These tests pin the two halves — reading the bundled id, and refusing an
 * answer that belongs to a different build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import {
  buildMatches,
  fetchServerBuild,
  parseBuildPayload,
  readBuildId,
  waitForMatchingBuild,
} from "../server-identity";

describe("readBuildId", () => {
  it("reads .next/BUILD_ID from a standalone bundle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-buildid-"));
    fs.mkdirSync(path.join(dir, ".next"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next", "BUILD_ID"), "abc123\n");
    expect(readBuildId(dir)).toBe("abc123");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a flat layout and returns null when there is no BUILD_ID", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-buildid-"));
    fs.writeFileSync(path.join(dir, "BUILD_ID"), "flat99");
    expect(readBuildId(dir)).toBe("flat99");
    fs.rmSync(path.join(dir, "BUILD_ID"));
    expect(readBuildId(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseBuildPayload", () => {
  it("parses the probe body", () => {
    expect(parseBuildPayload('{"buildId":"k1","version":"3.0.4"}')).toEqual({ buildId: "k1", version: "3.0.4" });
  });

  it("treats garbage and missing ids as no answer", () => {
    expect(parseBuildPayload("<html>404</html>")).toBeNull();
    expect(parseBuildPayload('{"version":"3.0.4"}')).toBeNull();
    expect(parseBuildPayload('{"buildId":""}')).toBeNull();
  });
});

describe("buildMatches", () => {
  it("accepts a match and refuses a different build", () => {
    expect(buildMatches("abc", "abc")).toBe(true);
    expect(buildMatches("abc", "def")).toBe(false);
    expect(buildMatches("abc", null)).toBe(false);
  });

  it("accepts anything when the bundle has no id to compare", () => {
    // A hand-built bundle without BUILD_ID must not be bricked by the check.
    expect(buildMatches(null, "whatever")).toBe(true);
    expect(buildMatches(null, null)).toBe(true);
  });
});

/** Answer /api/system/build with a fixed id. */
async function serve(buildId: string, status = 200): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/api/system/build" && status === 200) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ buildId }));
      return;
    }
    res.writeHead(status);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

describe("fetchServerBuild / waitForMatchingBuild", () => {
  it("reads the build id from a live server", async () => {
    const { server, url } = await serve("live-build");
    await expect(fetchServerBuild(url)).resolves.toEqual({ buildId: "live-build", version: undefined });
    server.close();
  });

  it("returns null for an error response and for a dead port", async () => {
    const { server, url } = await serve("x", 500);
    await expect(fetchServerBuild(url)).resolves.toBeNull();
    server.close();
    await expect(fetchServerBuild(url, 400)).resolves.toBeNull();
  });

  it("reports the mismatching id it saw instead of just failing", async () => {
    const { server, url } = await serve("old-build");
    const result = await waitForMatchingBuild(url, "new-build", 300, 50);
    expect(result.ok).toBe(false);
    expect(result.seen?.buildId).toBe("old-build");
    server.close();
  });

  it("succeeds once the right build answers", async () => {
    const { server, url } = await serve("new-build");
    const result = await waitForMatchingBuild(url, "new-build", 500, 50);
    expect(result.ok).toBe(true);
    expect(result.seen?.buildId).toBe("new-build");
    server.close();
  });
});
