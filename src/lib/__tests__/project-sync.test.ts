/**
 * project-sync.test.ts — the cross-machine roster sync core with injected
 * fakes: offline failure tolerance, conflict merging (newer wins, local alias
 * preserved, remote-only → ghost), first-sync with an empty remote,
 * unauthenticated no-op, malformed response handling, and the push payload
 * never containing device-bound data (handles/paths).
 */
import { syncProjects, buildPushEntries, type SyncDeps } from "../project-sync";
import type { ProjectEntry } from "../project-registry";

const KEY = "orplex.projects.v1";

function fakeStorage(initial: ProjectEntry[] = []) {
  const data = new Map<string, string>([[KEY, JSON.stringify(initial)]]);
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    read: () => JSON.parse(data.get(KEY) || "[]"),
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeDeps(opts: {
  local?: ProjectEntry[];
  respond?: () => Promise<ReturnType<typeof jsonResponse>> | never;
  reject?: boolean;
  remoteBody?: unknown;
}) {
  const storage = fakeStorage(opts.local ?? []);
  const requests: Array<{ input: string; init?: { method?: string; body?: string } }> = [];
  const deps: SyncDeps & { requests: typeof requests; storage: typeof storage } = {
    storage,
    requests,
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (opts.reject) throw new TypeError("Failed to fetch");
      if (opts.respond) return await opts.respond();
      return jsonResponse(200, { success: true, accepted: 0, projects: opts.remoteBody ?? [] });
    },
  };
  return deps;
}

const LOCAL: ProjectEntry[] = [
  { name: "orplex", displayName: "My Repo", lastOpenedAt: 300, ghost: false },
  { name: "logo", lastOpenedAt: 100, ghost: false },
];

describe("buildPushEntries", () => {
  it("projects to name/alias/timestamp and drops device-bound fields", () => {
    const entries = buildPushEntries([
      { name: "orplex", displayName: "Mine", lastOpenedAt: 5, ghost: false, lastPath: "C:\\secret\\orplex" },
      { name: "", lastOpenedAt: 9 }, // invalid → dropped
    ]);
    expect(entries).toEqual([{ name: "orplex", displayName: "Mine", lastOpenedAt: 5 }]);
    expect(JSON.stringify(entries)).not.toContain("lastPath");
    expect(JSON.stringify(entries)).not.toContain("secret");
    expect(JSON.stringify(entries)).not.toContain("ghost");
  });
});

describe("syncProjects", () => {
  it("first sync with an empty remote: pushes local, roster unchanged", async () => {
    const deps = makeDeps({ local: LOCAL, remoteBody: [] });
    const result = await syncProjects(deps);

    expect(result.ok).toBe(true);
    expect(result.projects).toHaveLength(2);
    // The caller (useProjects) persists — sync itself never writes storage.
    expect(deps.storage.read()).toEqual(LOCAL);
    expect(deps.requests[0].input).toBe("/api/projects");
    expect(deps.requests[0].init?.method).toBe("PUT");
  });

  it("offline (fetch throws) → ok:false, local roster untouched, never throws", async () => {
    const deps = makeDeps({ local: LOCAL, reject: true });
    const result = await syncProjects(deps);

    expect(result).toMatchObject({ ok: false, reason: "offline" });
    expect(deps.storage.read()).toEqual(LOCAL); // unchanged
  });

  it("unauthenticated → no-op keeping the local roster", async () => {
    const deps = makeDeps({ local: LOCAL, respond: async () => jsonResponse(401, { success: false }) });
    const result = await syncProjects(deps);

    expect(result).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(deps.storage.read()).toEqual(LOCAL);
  });

  it("server error → ok:false, local roster untouched", async () => {
    const deps = makeDeps({ local: LOCAL, respond: async () => jsonResponse(500, { success: false }) });
    const result = await syncProjects(deps);
    expect(result).toMatchObject({ ok: false, reason: "server-error" });
    expect(deps.storage.read()).toEqual(LOCAL);
  });

  it("conflict: newer remote timestamp wins; local alias preserved; ghost flags survive", async () => {
    const deps = makeDeps({
      local: [{ name: "orplex", displayName: "My Repo", lastOpenedAt: 100, ghost: false }],
      remoteBody: [
        // Remote opened orplex more recently — timestamp must win.
        { name: "orplex", displayName: undefined, lastOpenedAt: 900 },
        // Remote-only → ghost row locally.
        { name: "new camera", lastOpenedAt: 500 },
      ],
    });
    const result = await syncProjects(deps);

    expect(result.ok).toBe(true);
    const merged = result.projects!; // caller persists this (useProjects does)
    expect(merged.find((p) => p.name === "orplex")).toMatchObject({
      lastOpenedAt: 900,
      displayName: "My Repo", // local alias survives the remote's none
      ghost: false,           // local handle knowledge never cleared
    });
    expect(merged.find((p) => p.name === "new camera")).toMatchObject({ ghost: true });
  });

  it("malformed remote entries are dropped without failing the sync", async () => {
    const deps = makeDeps({
      local: LOCAL,
      remoteBody: [null, { nope: 1 }, { name: "" }, { name: "ok", lastOpenedAt: 7 }],
    });
    const result = await syncProjects(deps);

    expect(result.ok).toBe(true);
    const names = result.projects!.map((p) => p.name).sort();
    expect(names).toEqual(["logo", "ok", "orplex"]);
  });

  it("non-array projects body → bad-response, local untouched", async () => {
    const deps = makeDeps({ local: LOCAL, respond: async () => jsonResponse(200, { success: true, projects: "nope" }) });
    const result = await syncProjects(deps);
    expect(result).toMatchObject({ ok: false, reason: "bad-response" });
    expect(deps.storage.read()).toEqual(LOCAL);
  });

  it("malformed JSON body → bad-response, local untouched", async () => {
    const deps: SyncDeps = {
      storage: fakeStorage(LOCAL),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }),
    };
    const result = await syncProjects(deps);
    expect(result).toMatchObject({ ok: false, reason: "bad-response" });
  });
});
