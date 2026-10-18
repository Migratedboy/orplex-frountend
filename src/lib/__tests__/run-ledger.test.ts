/**
 * run-ledger.test.ts — The persistent run ledger: the agent's cross-restart
 * memory. Covers workspace-key scoping, the finalize payload built from real
 * prompt-meter/failure-memory state, the never-throw POST/GET client, the
 * server-failure merge into the Failure Doctrine, and hydration behavior.
 */
import { getWorkspaceKey, buildFinalizePayload, postRunToLedger, fetchLedgerFailures, hydrateFailureMemoryFromLedger } from "../run-ledger";
import { recordFailure, mergeServerFailures, getFailures, resetFailureMemory } from "../failure-memory";
import { resetPromptMeter, startTaskMeter, recordPromptCall } from "../prompt-meter";

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  resetFailureMemory();
  resetPromptMeter();
});

describe("getWorkspaceKey — stable learning scope", () => {
  it("scopes by folder name, never by full path or user", () => {
    expect(getWorkspaceKey("C:\\dev\\my-project")).toBe("orplex-local:my-project");
    expect(getWorkspaceKey("C:\\dev\\my-project\\")).toBe("orplex-local:my-project");
    expect(getWorkspaceKey("/home/u/my-project")).toBe("orplex-local:my-project");
  });

  it("handles missing folder without throwing", () => {
    expect(getWorkspaceKey(null)).toBe("orplex-local:(no-folder)");
    expect(getWorkspaceKey("")).toBe("orplex-local:(no-folder)");
  });
});

describe("buildFinalizePayload — from real meter + failure state", () => {
  it("carries meter economics and open failures", () => {
    startTaskMeter("task-1", "code");
    recordPromptCall({
      taskId: "task-1",
      turn: 1,
      profile: "full",
      mode: "code",
      systemChars: 40000,
      contextChars: 8000,
      why: "initial",
    });
    recordPromptCall({
      taskId: "task-1",
      turn: 2,
      profile: "compact",
      mode: "code",
      systemChars: 8000,
      contextChars: 6000,
      why: "tool-loop turn 2",
    });
    recordFailure("typecheck", "error TS2322: Type 'number' is not assignable", ["src/a.ts"]);

    const payload = buildFinalizePayload({
      taskId: "task-1",
      workspaceKey: "orplex-local:demo",
      task: "build a thing",
      mode: "code",
      finalStatus: "done",
      lanes: { typecheck: "fail", browser: "pass", swarm: "skipped" },
      durationMs: 45000,
    }) as any;

    expect(payload.workspaceKey).toBe("orplex-local:demo");
    expect(payload.run.finalStatus).toBe("done");
    expect(payload.run.modelCalls).toBe(2);
    expect(payload.run.fullCalls).toBe(1);
    expect(payload.run.compactCalls).toBe(1);
    expect(payload.run.tokensSaved).toBeGreaterThan(0);
    expect(payload.run.lanes.typecheck).toBe("fail");
    // open failure goes to the ledger for next-restart teaching
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0].kind).toBe("typecheck");
    // passing lanes resolve their signatures server-side
    expect(payload.passedLanes).toContain("browser");
    expect(payload.passedLanes).not.toContain("typecheck");
  });

  it("works with no meter and no failures — zeros, not crashes", () => {
    const payload = buildFinalizePayload({
      taskId: "task-empty",
      workspaceKey: "orplex-local:demo",
      task: "t",
      mode: "code",
      finalStatus: "error",
      lanes: { typecheck: "skipped", browser: "skipped", swarm: "skipped" },
      durationMs: 5,
    }) as any;
    expect(payload.run.modelCalls).toBe(0);
    expect(payload.failures).toEqual([]);
  });
});

describe("ledger client — never throws", () => {
  it("POST resolves ok:true on success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, id: "x" }), { status: 200 })) as typeof fetch;
    const res = await postRunToLedger({ workspaceKey: "k", run: { task: "t" } });
    expect(res.ok).toBe(true);
  });

  it("POST resolves ok:false — never rejects — on HTTP or network failure", async () => {
    global.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect((await postRunToLedger({})).ok).toBe(false);

    global.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await postRunToLedger({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fetch failed");
  });

  it("GET failures tolerate malformed responses", async () => {
    global.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    expect(await fetchLedgerFailures("k")).toBeNull();
    global.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    expect(await fetchLedgerFailures("k")).toBeNull();
  });
});

describe("mergeServerFailures — cross-restart doctrine hydration", () => {
  it("hydrates server signatures into the doctrine with counts", async () => {
    const merged = mergeServerFailures([
      { kind: "typecheck", detail: "error TS2304: Cannot find name 'boot'", files: ["src/nav.ts"], count: 3, when: Date.now() - 1000 },
    ]);
    expect(merged).toBeUndefined(); // returns void by design
    const failures = getFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].count).toBe(3);
    // The doctrine the model sees now carries the server-taught evidence.
    const { buildFailureDoctrineContext } = await import("../failure-memory");
    const ctx = buildFailureDoctrineContext();
    expect(ctx).toContain("RECURRING");
    expect(ctx).toContain("boot");
  });

  it("merges duplicates by raising count instead of double-inserting", async () => {
    recordFailure("browser", "Uncaught ReferenceError: X is not defined", []);
    mergeServerFailures([
      { kind: "browser", detail: "Uncaught ReferenceError: X is not defined", files: [], count: 2, when: Date.now() },
    ]);
    const failures = getFailures();
    expect(failures.filter((f) => f.kind === "browser")).toHaveLength(1);
    expect(failures[0].count).toBe(2);
  });

  it("hydrateFailureMemoryFromLedger wires the server into the doctrine", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          failures: [
            { kind: "command", detail: "EADDRINUSE: port 3001 busy", files: [], count: 2, when: Date.now() },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    const hydrated = await hydrateFailureMemoryFromLedger("orplex-local:demo");
    expect(hydrated).toBe(true);
    expect(getFailures().some((f) => f.detail.includes("EADDRINUSE"))).toBe(true);
  });

  it("ignores unknown kinds and empty payloads", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, failures: [] }), { status: 200 })) as typeof fetch;
    expect(await hydrateFailureMemoryFromLedger("k")).toBe(false);
    mergeServerFailures([{ kind: "bogus" as any, detail: "x", files: [], count: 1, when: Date.now() }]);
    expect(getFailures()).toHaveLength(0);
  });
});

describe("ledger endpoint — /api/agent/ledger, never the file-undo route", () => {
  it("POSTs the ledger payload to /api/agent/ledger (the bug fix)", async () => {
    let seenUrl = "";
    let seenMethod = "";
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method || "GET";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const res = await postRunToLedger({ workspaceKey: "k", run: { task: "t" } });
    expect(res.ok).toBe(true);
    expect(seenMethod).toBe("POST");
    // /api/agent/history requires {path, next} and 400'd every ledger POST.
    expect(seenUrl).toContain("/api/agent/ledger");
    expect(seenUrl).not.toContain("/api/agent/history");
  });

  it("reads open failures from /api/agent/ledger", async () => {
    let seenUrl = "";
    global.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ ok: true, failures: [] }), { status: 200 });
    }) as typeof fetch;

    expect(await fetchLedgerFailures("orplex-local:demo")).toEqual([]);
    expect(seenUrl).toContain("/api/agent/ledger?workspaceKey=orplex-local%3Ademo");
    expect(seenUrl).not.toContain("/api/agent/history");
  });

  it("degrades gracefully on 401 and on an absent (404) route", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as typeof fetch;
    const refused = await postRunToLedger({ workspaceKey: "k" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("HTTP 401");
    expect(await fetchLedgerFailures("k")).toBeNull();
    expect(await hydrateFailureMemoryFromLedger("k")).toBe(false);

    global.fetch = (async () => new Response("Not found", { status: 404 })) as typeof fetch;
    const absent = await postRunToLedger({});
    expect(absent.ok).toBe(false);
    expect(await fetchLedgerFailures("k")).toBeNull();
    expect(await hydrateFailureMemoryFromLedger("k")).toBe(false);
  });
});
