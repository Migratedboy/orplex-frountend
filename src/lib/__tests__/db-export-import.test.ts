// db-export-import.test.ts — round-trip: exportSnapshot → delete disk state
// → importSnapshot must restore identical rows; tampered bundles must skip.
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const storeDir = mkdtempSync(join(tmpdir(), "orplex-db-"));
process.env.ORPLEX_LOCAL_DB_DIR = storeDir;

import { buildLocalDbClient, exportSnapshot, importSnapshot } from "../local-db";

const mem = () => buildLocalDbClient() as any;

afterAll(() => {
  delete process.env.ORPLEX_LOCAL_DB_DIR;
  rmSync(storeDir, { recursive: true, force: true });
});

describe("export/import round-trip", () => {
  it("restores every model into the local db", async () => {
    const c = mem();
    await c.user.create({ data: { id: "u1", email: "a@b.c" } });
    await c.conversation.create({ data: { id: "c1", userId: "u1", title: "hi" } });
    await c.message.create({ data: { id: "m1", conversationId: "c1", role: "user", content: "yo" } });

    const bundle = exportSnapshot();
    expect(existsSync(bundle)).toBe(true);

    // Wipe the store, then import.
    for (const f of ["user", "conversation", "message"]) rmSync(join(storeDir, `${f}.json`), { force: true });
    const result = importSnapshot(bundle);
    expect(result.restored.user).toBe(1);
    expect(result.restored.conversation).toBe(1);
    expect(result.restored.message).toBe(1);
    expect(result.skipped).toEqual([]);

    const c2 = mem();
    const users = await c2.user.findMany({});
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("a@b.c");
    const conv = await c2.conversation.findMany({ include: { messages: true } });
    expect(conv[0].messages).toHaveLength(1);
  });

  it("skips tampered rows (checksum mismatch) without breaking the rest", async () => {
    const c = mem();
    await c.user.create({ data: { id: "u2", email: "keep@me" } });
    await c.conversation.create({ data: { id: "c2", userId: "u2", title: "keep" } });
    const bundle = exportSnapshot();
    const raw = JSON.parse(readFileSync(bundle, "utf8"));
    raw.models.conversation.rows[0].title = "tampered";
    writeFileSync(bundle, JSON.stringify(raw), "utf8");
    const result = importSnapshot(bundle);
    expect(result.skipped).toEqual(["conversation (checksum mismatch)"]);
    expect(result.restored.user).toBeGreaterThanOrEqual(1);
  });

  it("rejects bundles that are not ours", () => {
    const bad = join(storeDir, "bad.json");
    writeFileSync(bad, JSON.stringify({ engine: "other", models: {} }), "utf8");
    expect(() => importSnapshot(bad)).toThrow(/not an orplex-localdb snapshot/);
  });

  it("corrupt file restores from .bak instead of serving empty", async () => {
    const c = mem();
    await c.user.create({ data: { id: "u3", email: "bak@me" } });
    // flush happens async; force a flush by waiting then corrupting
    await new Promise((r) => setTimeout(r, 60));
    const f = join(storeDir, "user.json");
    expect(existsSync(`${f}.bak`)).toBe(true);
    writeFileSync(f, "{corrupt", "utf8");
    // Fresh client → load path must restore from .bak.
    jest.resetModules();
    const fresh = (await import("../local-db")) as any;
    const c3 = fresh.buildLocalDbClient();
    const users = await c3.user.findMany({});
    expect(users.some((u: any) => u.id === "u3")).toBe(true);
  });
});
