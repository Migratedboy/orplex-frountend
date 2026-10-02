/**
 * project-reopen.test.ts — the re-open orchestrator's full contract, tested
 * with injected fakes (no browser): the permission decision table, success
 * ordering (attach → touch), and every error path returning typed outcomes
 * instead of throwing.
 */
import { reopenProject, decidePermissionPath, type ReopenDeps } from "../project-reopen";

type Perm = "granted" | "denied" | "unsupported";

function makeDeps(overrides: Partial<ReopenDeps> = {}) {
  const calls: string[] = [];
  const deps: ReopenDeps & { calls: string[] } = {
    calls,
    loadHandle: async (name) => ({ name, kind: "directory" } as unknown as FileSystemDirectoryHandle),
    checkPermission: async (_h, _mode, query) => {
      calls.push(query ? "query" : "prompt");
      return "granted";
    },
    attach: async (h) => {
      calls.push(`attach:${h.name}`);
      return { fileCount: 42 };
    },
    touch: (name) => calls.push(`touch:${name}`),
    ...overrides,
  };
  return deps;
}

describe("decidePermissionPath (pure table)", () => {
  it("query granted → go, no prompt", () => {
    expect(decidePermissionPath("granted", "not-needed")).toBe("go");
  });

  it("query unsupported (legacy browser) → go, no prompt", () => {
    expect(decidePermissionPath("unsupported", "not-needed")).toBe("go");
  });

  it("query denied + prompt granted → go", () => {
    expect(decidePermissionPath("denied", "granted")).toBe("go");
  });

  it("query denied + prompt unsupported → go (best effort)", () => {
    expect(decidePermissionPath("denied", "unsupported")).toBe("go");
  });

  it("query denied + prompt denied → denied (never re-prompt)", () => {
    expect(decidePermissionPath("denied", "denied")).toBe("denied");
  });
});

describe("reopenProject", () => {
  it("happy path: silent query only (no prompt), attach then touch, ok outcome", async () => {
    const deps = makeDeps();
    const outcome = await reopenProject("orplex", deps);

    expect(outcome).toMatchObject({ status: "ok", name: "orplex", fileCount: 42 });
    expect(deps.calls).toEqual(["query", "attach:orplex", "touch:orplex"]);
  });

  it("prompts exactly once when the silent query is denied, then proceeds", async () => {
    const deps = makeDeps({
      checkPermission: async (_h, _mode, query) => {
        deps.calls.push(query ? "query" : "prompt");
        return query ? "denied" : "granted";
      },
    });
    const outcome = await reopenProject("logo", deps);

    expect(outcome.status).toBe("ok");
    expect(deps.calls).toEqual(["query", "prompt", "attach:logo", "touch:logo"]);
  });

  it("denied prompt → typed denied outcome, no attach, no touch, never throws", async () => {
    const deps = makeDeps({
      checkPermission: async (_h, _mode, query) => {
        deps.calls.push(query ? "query" : "prompt");
        return "denied";
      },
    });
    const outcome = await reopenProject("psd10", deps);

    expect(outcome).toMatchObject({ status: "denied", name: "psd10" });
    expect(outcome.message).toContain("psd10");
    expect(outcome.message).toContain("stays in your list");
    expect(deps.calls).toEqual(["query", "prompt"]); // attach/touch never ran
  });

  it("missing persisted handle → not-found with an actionable message", async () => {
    const deps = makeDeps({ loadHandle: async () => null });
    const outcome = await reopenProject("new camera", deps);

    expect(outcome.status).toBe("not-found");
    expect(outcome.message).toContain("new camera");
    expect(outcome.message).toContain("Open"); // tells the user how to re-bind
    expect(deps.calls).toEqual([]); // no permission work without a handle
  });

  it("loadHandle storage failure → failed outcome, never a rejection", async () => {
    // IndexedDB can throw (quota, DB closed) — the "NEVER throws" contract
    // turns that into a typed failed outcome instead of an uncaught promise
    // rejection in the caller's event handler.
    const deps = makeDeps({
      loadHandle: async () => {
        throw new Error("IndexedDB closed");
      },
    });
    const outcome = await reopenProject("orplex", deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("IndexedDB closed");
    expect(deps.calls).toEqual([]); // no permission work without a handle
  });

  it("blank name → invalid outcome, no handle lookup", async () => {
    const deps = makeDeps();
    expect((await reopenProject("", deps)).status).toBe("invalid");
    expect((await reopenProject("   ", deps)).status).toBe("invalid");
    expect(deps.calls).toEqual([]);
  });

  it("attach failure → failed outcome carrying the reason, no touch", async () => {
    const deps = makeDeps({
      attach: async () => {
        throw new Error("disk gone");
      },
    });
    const outcome = await reopenProject("orplex", deps);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("disk gone");
    expect(deps.calls).toEqual(["query"]); // touch never ran
  });

  it("permission API throwing is treated as denied, not a crash", async () => {
    const deps = makeDeps({
      checkPermission: async () => {
        throw new Error("SecurityError");
      },
    });
    const outcome = await reopenProject("orplex", deps);
    expect(outcome.status).toBe("denied");
  });

  it("trims surrounding whitespace from the requested name", async () => {
    const deps = makeDeps();
    const outcome = await reopenProject("  orplex  ", deps);
    expect(outcome.name).toBe("orplex");
  });
});
