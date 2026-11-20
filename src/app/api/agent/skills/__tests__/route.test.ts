// route.test.ts — /api/agent/skills: the chat lane's skill roster + body read.
//
// This is the contract `use_skill` depends on: a 404 carries the real roster
// (so a typo is one corrected call away) and a found skill carries its body.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../route";

let mockRoot = "";
let mockUserId: string | null = "test-user";

// The route authenticates through sessionUserId so the PACKAGED app (no
// NEXTAUTH_SECRET, Ed25519 app-session cookie) works too — getServerSession
// could not read that cookie and answered 401 for use_skill's own lane.
jest.mock("@/lib/server-session", () => ({ sessionUserId: async () => mockUserId }));
jest.mock("@/lib/workspace-cwd", () => ({
  getWorkspaceCwd: () => mockRoot,
  resolveWorkspaceCwd: async () => mockRoot || null,
}));

const get = (query = "") => GET(new NextRequest(`http://localhost/api/agent/skills${query}`));

async function seed(folder: string, content: string) {
  const dir = join(mockRoot, ".orplex", "skills", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

describe("GET /api/agent/skills", () => {
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), "orplex-skills-route-"));
  });

  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
  });

  it("returns the roster with every discovered skill", async () => {
    await seed("deploy", "---\nname: deploy\ndescription: Ship the app\n---\nRun the deploy script.");
    await seed("review", '---\nname: "review"\ndescription: "PR review pass"\n---\nReview steps.');

    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skills.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(["deploy", "review"]));
    expect(body.roster).toContain("- deploy: Ship the app");
    expect(body.roster).toContain("review");
  });

  it("returns a skill body by name", async () => {
    await seed("deploy", "---\nname: deploy\ndescription: Ship the app\n---\nRun the deploy script.");

    const res = await get("?name=Deploy");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.name).toBe("deploy");
    expect(body.body).toBe("Run the deploy script.");
  });

  it("404s with the roster so the agent can correct a name", async () => {
    await seed("deploy", "---\nname: deploy\ndescription: Ship the app\n---\nsteps");

    const res = await get("?name=does-not-exist-xyz");
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.roster).toContain("deploy");
  });

  it("is not an error when no workspace folder is registered", async () => {
    mockRoot = "";
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, roster: "", skills: [] });
  });

  it("401s when there is no session (app-session or next-auth)", async () => {
    mockUserId = null;
    try {
      const res = await get();
      expect(res.status).toBe(401);
    } finally {
      mockUserId = "test-user";
    }
  });
});
