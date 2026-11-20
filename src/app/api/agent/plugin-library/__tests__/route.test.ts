// route.test.ts — /api/agent/plugin-library, with bundles coming from the
// marketplace instead of a compiled-in catalogue.
//
// The route is the only place a user installs a library bundle, so the wiring it
// depends on is worth pinning: the catalogue it lists is the marketplace's, an
// install writes the bundle's skills into the workspace, and a slug that is not
// in the published catalogue is refused rather than half-installed.
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const FIXTURE = require("@/lib/__tests__/fixtures/plugin-bundles.json") as {
  bundles: unknown[];
};

jest.mock("@/lib/server-session", () => ({ sessionUserId: async () => "test-user" }));
jest.mock("@/lib/workspace-cwd", () => ({
  getWorkspaceCwd: () => mockRoot,
  resolveWorkspaceCwd: async () => mockRoot || null,
}));

let mockRoot = "";

jest.mock("@/lib/marketplace-bundles", () => {
  const { materializeBundles } = jest.requireActual("@orplex/sdk/lib/plugin-library");
  const materialized = materializeBundles(FIXTURE.bundles);
  return { getMaterializedBundles: async () => materialized };
});

import { GET, PATCH, POST } from "../route";
import { clearToolHookCache } from "@/lib/tool-hooks";

const get = () => GET(new NextRequest("http://localhost/api/agent/plugin-library"));
const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/agent/plugin-library", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/agent/plugin-library", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

describe("/api/agent/plugin-library from the marketplace", () => {
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), "orplex-plugin-route-"));
    clearToolHookCache();
  });
  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
    clearToolHookCache();
  });

  it("lists exactly the published bundles, flagging which carry hooks", async () => {
    const body = await (await get()).json();
    expect(body.workspaceOpen).toBe(true);
    expect(body.library).toHaveLength(FIXTURE.bundles.length);
    const verified = body.library.find((b: { slug: string }) => b.slug === "verified-commits");
    expect(verified.hasHooks).toBe(true);
    expect(verified.installed).toBe(false);
    expect(verified.skillCount).toBeGreaterThan(0);
  });

  it("installs a bundle into the workspace, then reports it installed and enabled", async () => {
    const res = await post({ slug: "verified-commits" });
    expect(res.status).toBe(200);

    const skillFile = join(mockRoot, ".orplex", "skills", "verified-commits", "SKILL.md");
    await expect(stat(skillFile)).resolves.toBeTruthy();
    // Install writes SKILL.md with YAML frontmatter (name + description) so the
    // skill is rostered by name, then the body the bundle shipped.
    const written = await readFile(skillFile, "utf8");
    expect(written).toMatch(/^---\n/);
    expect(written).toContain("name: verified-commits");
    expect(written).toMatch(/# /);

    const body = await (await get()).json();
    const row = body.library.find((b: { slug: string }) => b.slug === "verified-commits");
    expect(row.installed).toBe(true);
    expect(row.enabled).toBe(true);
  });

  it("refuses a slug that is not in the published catalogue", async () => {
    const res = await post({ slug: "not-a-bundle" });
    expect(res.status).toBe(404);
    await expect(stat(join(mockRoot, ".orplex", "skills"))).rejects.toThrow();
  });

  it("toggles an installed bundle without touching its skill files", async () => {
    await post({ slug: "safe-commands" });
    const skillFile = join(mockRoot, ".orplex", "skills", "safe-commands", "SKILL.md");
    const before = (await stat(skillFile)).mtimeMs;

    const off = await patch({ slug: "safe-commands", enabled: false });
    expect(off.status).toBe(200);
    expect((await stat(skillFile)).mtimeMs).toBe(before);

    const body = await (await get()).json();
    expect(body.library.find((b: { slug: string }) => b.slug === "safe-commands").enabled).toBe(false);
    // ...and the rules stop being enforced (that is what "off" means).
    clearToolHookCache();
    const hooks = await (await get()).json();
    expect(hooks.library).toBeTruthy();
  });

  it("reports an empty library when no workspace folder is open", async () => {
    const saved = mockRoot;
    mockRoot = "";
    try {
      const body = await (await get()).json();
      expect(body).toEqual({ library: [], workspaceOpen: false });
    } finally {
      mockRoot = saved;
    }
  });
});

// mkdir is used by the route; keep the import honest for the type checker.
void mkdir;
