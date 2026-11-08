import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { appendHistory, appendKeepMarkers } from "@/lib/workspace-history";
import { GET, POST, PUT } from "../route";

let mockRoot = "";

jest.mock("next-auth", () => ({ getServerSession: async () => ({ user: { id: "test-user" } }) }));
jest.mock("@/lib/auth", () => ({ jwtOnlyOptions: {} }));
jest.mock("@/lib/workspace-cwd", () => ({ getWorkspaceCwd: () => mockRoot }));

function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`http://localhost/api/agent/history${query}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("agent history changes API", () => {
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), "orplex-history-route-"));
  });

  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
  });

  it("keeps one file and undoes another without dropping the remaining pending snapshot", async () => {
    await mkdir(join(mockRoot, "src"), { recursive: true });
    await writeFile(join(mockRoot, "src", "keep.ts"), "accepted");
    await writeFile(join(mockRoot, "src", "undo.ts"), "updated");
    await writeFile(join(mockRoot, "src", "remaining.ts"), "still pending");
    await appendHistory(mockRoot, { path: "src/keep.ts", prev: "before", next: "accepted" });
    await appendHistory(mockRoot, { path: "src/undo.ts", prev: "original", next: "updated" });
    await appendHistory(mockRoot, { path: "src/remaining.ts", prev: "old", next: "still pending" });

    const undoResponse = await PUT(request("PUT", { action: "undo-pending", paths: ["src/undo.ts"] }));
    expect(undoResponse.status).toBe(200);
    expect(await readFile(join(mockRoot, "src", "undo.ts"), "utf8")).toBe("original");

    const keepResponse = await POST(request("POST", { action: "keep", paths: ["src/keep.ts"] }));
    expect(keepResponse.status).toBe(200);
    const pendingResponse = await GET(request("GET", undefined, "?view=pending"));
    expect(await pendingResponse.json()).toMatchObject({
      files: [{
        path: "src/remaining.ts",
        before: "old",
        current: "still pending",
      }],
    });
  });

  it("undoes created and deleted files and preserves pending state across reload-style reads", async () => {
    await mkdir(join(mockRoot, "src"), { recursive: true });
    await writeFile(join(mockRoot, "src", "created.ts"), "new file");
    await appendHistory(mockRoot, { path: "src/created.ts", prev: null, next: "new file" });
    await appendHistory(mockRoot, { path: "src/deleted.ts", prev: "restored", next: null });

    const pendingResponse = await GET(request("GET", undefined, "?view=pending"));
    expect((await pendingResponse.json()).files).toHaveLength(2);

    const undoResponse = await PUT(request("PUT", {
      action: "undo-pending",
      paths: ["src/created.ts", "src/deleted.ts"],
    }));
    expect(undoResponse.status).toBe(200);
    await expect(readFile(join(mockRoot, "src", "created.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(mockRoot, "src", "deleted.ts"), "utf8")).toBe("restored");
  });

  it("requires confirmation before overwriting content changed after the agent write", async () => {
    await mkdir(join(mockRoot, "src"), { recursive: true });
    await writeFile(join(mockRoot, "src", "manual.ts"), "manual edit");
    await appendHistory(mockRoot, { path: "src/manual.ts", prev: "original", next: "agent edit" });

    const conflict = await PUT(request("PUT", { action: "undo-pending", paths: ["src/manual.ts"] }));
    expect(conflict.status).toBe(409);
    expect(await readFile(join(mockRoot, "src", "manual.ts"), "utf8")).toBe("manual edit");

    const confirmed = await PUT(request("PUT", {
      action: "undo-pending",
      paths: ["src/manual.ts"],
      confirmChanges: true,
    }));
    expect(confirmed.status).toBe(200);
    expect(await readFile(join(mockRoot, "src", "manual.ts"), "utf8")).toBe("original");
  });

  it("uses the same history for tool undo and stops at a Keep marker", async () => {
    await mkdir(join(mockRoot, "src"), { recursive: true });
    await writeFile(join(mockRoot, "src", "tool.ts"), "kept");
    await appendHistory(mockRoot, { path: "src/tool.ts", prev: "before", next: "kept" });
    await appendKeepMarkers(mockRoot, ["src/tool.ts"]);

    const response = await PUT(request("PUT", { path: "src/tool.ts" }));
    expect(response.status).toBe(404);
    expect(await readFile(join(mockRoot, "src", "tool.ts"), "utf8")).toBe("kept");
  });
});
