// route.test.ts — /api/agent/tool-hooks: the chat lane's view of the workspace
// deny rules (orplex.config.json + enabled plugin bundles), compiled from the
// same loadToolHooks the executor uses.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { clearToolHookCache } from "@/lib/tool-hooks";

let mockRoot = "";

jest.mock("@/lib/server-session", () => ({ sessionUserId: async () => "test-user" }));
jest.mock("@/lib/workspace-cwd", () => ({
  getWorkspaceCwd: () => mockRoot,
  resolveWorkspaceCwd: async () => mockRoot || null,
}));

const get = () => GET(new NextRequest("http://localhost/api/agent/tool-hooks"));

describe("GET /api/agent/tool-hooks", () => {
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), "orplex-tool-hooks-"));
    clearToolHookCache();
  });

  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
    clearToolHookCache();
  });

  it("returns the workspace's deny rule sources", async () => {
    await writeFile(
      join(mockRoot, "orplex.config.json"),
      JSON.stringify({ toolHooks: { deny: ["rm\\s+-rf\\s+/"], notify: ["run_command"] } }),
      "utf8",
    );

    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Rule SOURCES come back (regex-escaped), so assert they compile and
    // still match the thing they are meant to block.
    expect(body.deny.some((r: string) => new RegExp(r, "i").test("run_command rm -rf /"))).toBe(true);
    expect(body.deny.some((r: string) => new RegExp(r, "i").test("npm run build"))).toBe(false);
    expect(body.notify).toContain("run_command");
    expect(body.errors).toEqual([]);
  });

  it("includes rules from an enabled installed plugin bundle", async () => {
    await mkdir(join(mockRoot, ".orplex", "skills", "verified-commits"), { recursive: true });
    await writeFile(join(mockRoot, ".orplex", "skills", "verified-commits", "SKILL.md"), "# x\n", "utf8");
    await writeFile(
      join(mockRoot, ".orplex", "bundles.json"),
      JSON.stringify({ "verified-commits": { enabled: true, rules: { deny: ["--no-verify"], notify: [] } } }),
      "utf8",
    );

    const body = await (await get()).json();
    expect(body.deny).toContain("--no-verify");
  });

  it("is empty (not an error) when no folder is open", async () => {
    mockRoot = "";
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, workspaceOpen: false, deny: [] });
  });
});
