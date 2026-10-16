/**
 * End-to-end check of the .zip path across the REAL route handlers:
 *
 *   POST /api/attachments   →  .orplex/attachments/<hash>.zip on disk
 *   GET  /api/attachments/… →  the bytes back with the right Content-Type
 *   extractArchiveTool      →  real extraction from the real saved file
 *
 * The earlier suites proved the units worked; nothing proved they were
 * connected. An archive that is stored but never reachable by the tool is
 * exactly the failure this covers.
 */

import JSZip from "jszip";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- auth/workspace stand-ins (the only things faked) ----------------------
const session = { user: { id: "u1" } };
jest.mock("next-auth", () => ({ getServerSession: jest.fn(async () => session) }));

let WORKSPACE = "";
jest.mock("@/lib/workspace-cwd", () => ({
  // Both resolvers are mocked: the routes use the async one (DB fallback).
  getWorkspaceCwdForUser: jest.fn(() => WORKSPACE || null),
  resolveWorkspaceCwd: jest.fn(async () => WORKSPACE || null),
}));

import { POST } from "@/app/api/attachments/route";
import { GET } from "@/app/api/attachments/[id]/route";
import { extractZip } from "@/lib/agent/archive-extract";
import { attachmentRef } from "@/lib/attachment-store";

/** Build a real zip and return the data URL a browser would produce. */
async function zipDataUrl(): Promise<string> {
  const z = new JSZip();
  z.file("src/index.ts", "export const answer = 42;");
  z.file("README.md", "# demo\n");
  z.file("nested/deep/keep.txt", "kept");
  const buf = await z.generateAsync({ type: "nodebuffer" });
  return `data:application/zip;base64,${buf.toString("base64")}`;
}

function post(dataUrl: unknown) {
  return POST({
    json: async () => ({ dataUrl }),
  } as never);
}

beforeEach(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), "orplex-e2e-"));
});

afterEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

describe("zip attach → store → serve → extract", () => {
  it("persists a real zip to the workspace", async () => {
    const res = await post(await zipDataUrl());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.filename).toBe(`${body.id}.zip`);
    expect(body.url).toBe(`/api/attachments/${body.id}.zip`);

    // It must really be on the user's disk, in the right place.
    const stored = await readdir(join(WORKSPACE, ".orplex", "attachments"));
    expect(stored).toEqual([`${body.id}.zip`]);
  });

  it("serves the stored bytes back with a zip Content-Type", async () => {
    const { id, filename } = await (await post(await zipDataUrl())).json();

    const res = await GET({} as never, { params: Promise.resolve({ id: filename }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");

    // The served bytes must be a loadable zip, not a mangled string.
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual([
      "README.md",
      "nested/",
      "nested/deep/",
      "nested/deep/keep.txt",
      "src/",
      "src/index.ts",
    ]);
    expect(await zip.file("src/index.ts")!.async("string")).toBe(
      "export const answer = 42;",
    );
  });

  it("the model-visible path resolves to a file the tool can actually extract", async () => {
    // This is the link that matters: the path the model is told about must be
    // the path extract_archive reads, relative to the workspace root.
    const { id, filename } = await (await post(await zipDataUrl())).json();
    const ref = attachmentRef(id, ".zip");
    const relPath = `.orplex/attachments/${ref.slice("attachment:".length)}`;

    expect(relPath).toBe(`.orplex/attachments/${filename}`);

    const out = await extractZip({ root: WORKSPACE, archivePath: relPath });

    // Default destination must NOT bury project files under the app's own
    // state dir — an attached archive extracts to the workspace root instead.
    expect(out.ok).toBe(true);
    expect(out.written.map((w) => w.path).sort()).toEqual([
      "README.md",
      "nested/deep/keep.txt",
      "src/index.ts",
    ]);
    expect(out.dest).toBe(id);
    expect(await readFile(join(WORKSPACE, id, "src", "index.ts"), "utf8")).toBe(
      "export const answer = 42;",
    );
  });

  it("honours an explicit dest so files land somewhere readable", async () => {
    const { id } = await (await post(await zipDataUrl())).json();
    const relPath = `.orplex/attachments/${id}.zip`;

    const out = await extractZip({ root: WORKSPACE, archivePath: relPath, destRel: "my-app" });

    expect(out.ok).toBe(true);
    expect(out.dest).toBe("my-app");
    expect(await readFile(join(WORKSPACE, "my-app", "src", "index.ts"), "utf8")).toBe(
      "export const answer = 42;",
    );
  });

  it("rejects a non-zip data URL", async () => {
    const res = await post("data:text/html;base64,PHNjcmlwdD4=");
    expect(res.status).toBe(400);
  });

  it("refuses to serve a traversal id", async () => {
    const res = await GET({} as never, {
      params: Promise.resolve({ id: "..%2f..%2fsecret.zip" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("401s without a session", async () => {
    const { getServerSession } = await import("next-auth");
    (getServerSession as jest.Mock).mockResolvedValueOnce(null);
    const res = await post(await zipDataUrl());
    expect(res.status).toBe(401);
  });

  it("404s when no workspace is open", async () => {
    WORKSPACE = "";
    const res = await post(await zipDataUrl());
    expect(res.status).toBe(404);
  });
});
