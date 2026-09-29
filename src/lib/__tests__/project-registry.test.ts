/**
 * project-registry.test.ts — the per-device project roster's pure core:
 * parse/serialize robustness, CRUD, ordering, rename/ghost/forget, roster
 * merge semantics, and the IndexedDB wrapper's no-browser degradation.
 */
import {
  parseRoster,
  listProjects,
  rememberProject,
  touchProject,
  setProjectAlias,
  forgetProject,
  mergeRosters,
  saveProjectHandle,
  loadProjectHandle,
  deleteProjectHandle,
  requestHandlePermission,
  type ProjectEntry,
} from "../project-registry";

/** The pruned surface has no getProject — read via listProjects. */
function getProject(store: ReturnType<typeof fakeStorage>, name: string): ProjectEntry | null {
  return listProjects(store).find((p) => p.name === name) ?? null;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    dump: () => Object.fromEntries(data),
  };
}

describe("parseRoster", () => {
  it("returns [] for null, corrupt JSON, and non-arrays", () => {
    expect(parseRoster(null)).toEqual([]);
    expect(parseRoster("{not json")).toEqual([]);
    expect(parseRoster(JSON.stringify({ oops: true }))).toEqual([]);
    expect(parseRoster("42")).toEqual([]);
  });

  it("filters invalid entries and coerces fields", () => {
    const raw = JSON.stringify([
      { name: "orplex", lastOpenedAt: 100 },
      { nope: true },
      { name: "" }, // empty name invalid
      { name: "logo", displayName: "Logo Project", ghost: true }, // no lastOpenedAt → 0
    ]);
    const parsed = parseRoster(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: "orplex", displayName: undefined, lastOpenedAt: 100, ghost: false });
    expect(parsed[1]).toEqual({ name: "logo", displayName: "Logo Project", lastOpenedAt: 0, ghost: true });
  });

  it("round-trips through JSON.stringify (serializeRoster is private)", () => {
    const entries: ProjectEntry[] = [{ name: "psd10", displayName: "PSD", lastOpenedAt: 7, ghost: false }];
    expect(parseRoster(JSON.stringify(entries))).toEqual(entries);
  });
});

describe("roster CRUD", () => {
  it("rememberProject inserts and sorts most-recent-first", () => {
    const store = fakeStorage();
    rememberProject(store, "orplex", { openedAt: 100 });
    rememberProject(store, "logo", { openedAt: 200 });
    const list = listProjects(store);
    expect(list.map((p) => p.name)).toEqual(["logo", "orplex"]);
  });

  it("rememberProject updates an existing entry and moves it to front", () => {
    const store = fakeStorage();
    rememberProject(store, "a", { openedAt: 100 });
    rememberProject(store, "b", { openedAt: 200 });
    rememberProject(store, "a", { openedAt: 300 });
    expect(listProjects(store).map((p) => p.name)).toEqual(["a", "b"]);
    expect(getProject(store, "a")!.lastOpenedAt).toBe(300);
  });

  it("rememberProject keeps displayName/ghost across re-opens and sets them per-call", () => {
    const store = fakeStorage();
    rememberProject(store, "a", { displayName: "Alpha", ghost: true });
    rememberProject(store, "a", { openedAt: 5 }); // no explicit fields → preserved
    expect(getProject(store, "a")).toMatchObject({ displayName: "Alpha", ghost: true, lastOpenedAt: 5 });
    rememberProject(store, "a", { displayName: "Al", ghost: false });
    expect(getProject(store, "a")).toMatchObject({ displayName: "Al", ghost: false });
  });

  it("rememberProject ignores blank names", () => {
    const store = fakeStorage();
    expect(rememberProject(store, "   ")).toEqual([]);
    expect(rememberProject(store, "")).toEqual([]);
  });

  it("touchProject updates timestamp; unknown names are a no-op", () => {
    const store = fakeStorage();
    rememberProject(store, "a", { openedAt: 1 });
    touchProject(store, "a", 99);
    expect(getProject(store, "a")!.lastOpenedAt).toBe(99);
    touchProject(store, "ghost-name", 5); // unknown → untouched roster
    expect(getProject(store, "ghost-name")).toBeNull();
  });

  it("setProjectAlias sets and clears the alias without touching the name", () => {
    const store = fakeStorage();
    rememberProject(store, "folder-x", { openedAt: 1 });
    setProjectAlias(store, "folder-x", "My Project");
    expect(getProject(store, "folder-x")).toMatchObject({ name: "folder-x", displayName: "My Project" });
    setProjectAlias(store, "folder-x", null);
    expect(getProject(store, "folder-x")!.displayName).toBeUndefined();
    // Blank alias clears too
    setProjectAlias(store, "folder-x", "  ");
    expect(getProject(store, "folder-x")!.displayName).toBeUndefined();
    expect(setProjectAlias(store, "unknown", "nope")).toEqual(listProjects(store));
  });

  it("forgetProject removes only that project", () => {
    const store = fakeStorage();
    rememberProject(store, "a", { openedAt: 1 });
    rememberProject(store, "b", { openedAt: 2 });
    forgetProject(store, "a");
    expect(listProjects(store).map((p) => p.name)).toEqual(["b"]);
  });

  it("caps the roster at 50 projects (oldest dropped)", () => {
    const store = fakeStorage();
    for (let i = 0; i < 55; i++) rememberProject(store, `p${i}`, { openedAt: i });
    const list = listProjects(store);
    expect(list).toHaveLength(50);
    expect(list[0].name).toBe("p54"); // newest kept
    expect(list.find((p) => p.name === "p0")).toBeUndefined(); // oldest dropped
  });
});

describe("mergeRosters (cross-machine sync semantics)", () => {
  it("unions by name; remote-only projects become ghosts", () => {
    const local: ProjectEntry[] = [{ name: "orplex", lastOpenedAt: 100 }];
    const remote: ProjectEntry[] = [
      { name: "orplex", lastOpenedAt: 50 },
      { name: "logo", lastOpenedAt: 200 },
    ];
    const merged = mergeRosters(local, remote);
    expect(merged.map((p) => p.name)).toEqual(["logo", "orplex"]);
    expect(merged.find((p) => p.name === "logo")!.ghost).toBe(true);
    expect(merged.find((p) => p.name === "orplex")!.ghost).toBe(false);
  });

  it("newer lastOpenedAt wins; local displayName preserved over remote-none", () => {
    const local: ProjectEntry[] = [{ name: "a", lastOpenedAt: 300, displayName: "Mine" }];
    const remote: ProjectEntry[] = [{ name: "a", lastOpenedAt: 900, displayName: undefined }];
    const merged = mergeRosters(local, remote);
    expect(merged[0]).toMatchObject({ name: "a", lastOpenedAt: 900, displayName: "Mine" });
  });

  it("local ghost knowledge is never cleared by the remote", () => {
    const local: ProjectEntry[] = [{ name: "a", lastOpenedAt: 1, ghost: false }];
    const remote: ProjectEntry[] = [{ name: "a", lastOpenedAt: 2, ghost: false }];
    // Local says not-ghost (has handle); remote can't undo that.
    expect(mergeRosters(local, remote)[0].ghost).toBe(false);
  });

  it("skips malformed remote entries", () => {
    const local: ProjectEntry[] = [];
    const remote = [{ name: "ok", lastOpenedAt: 5 }, null, { nope: 1 }] as unknown as ProjectEntry[];
    const merged = mergeRosters(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("ok");
  });
});

describe("IndexedDB handle store — no-browser degradation", () => {
  it("resolves null / no-ops without throwing when indexedDB is unavailable", async () => {
    await expect(saveProjectHandle("x", {} as FileSystemDirectoryHandle)).resolves.toBeUndefined();
    await expect(loadProjectHandle("x")).resolves.toBeNull();
    await expect(deleteProjectHandle("x")).resolves.toBeUndefined();
  });

  it("requestHandlePermission reports unsupported/denied without the FS Access API", async () => {
    expect(await requestHandlePermission({} as FileSystemDirectoryHandle)).toBe("unsupported");
    const denying = {
      queryPermission: async () => "denied",
      requestPermission: async () => "denied",
    } as unknown as FileSystemDirectoryHandle;
    expect(await requestHandlePermission(denying, "readwrite", true)).toBe("denied");
  });
});
