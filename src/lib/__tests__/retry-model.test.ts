/**
 * retry-model.test.ts — The auto-retry model swap (per-conversation failure
 * trail) rests on two pieces:
 *
 *   1. pickRetryModel (model-catalog): given the ids that failed in a
 *      conversation, choose the next probe-verified model — never one of the
 *      failed ones, green (freshly verified) before amber, null when the
 *      catalog has nothing left (the caller keeps the user's pick).
 *   2. startTask model stamping (background-chat): the task remembers WHICH
 *      model it was sent to — both in the live task (the useChatSession
 *      subscriber records task.model on status "error") and in the reload
 *      snapshot — so a failure can name the culprit.
 *
 * The catalog is seeded directly (seedCatalogForTests): getVerifiedModels
 * short-circuits on a fresh memory cache, so no network and no jest.mock of
 * same-module calls (which never intercepts) — see wake-engine.test.ts.
 */
import {
  seedCatalogForTests,
  resetModelCatalogForTests,
  pickRetryModel,
  type CatalogResult,
  type CatalogModel,
} from "../model-catalog";
import {
  startTask,
  getCurrentTask,
  persistTaskSnapshot,
  readTaskSnapshot,
  clearTaskSnapshot,
  cancelTask,
} from "../background-chat";

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    provider: id.split("/")[0] ?? id,
    verified: true,
    contextWindow: 131072,
    ...extra,
  };
}

function seed(models: CatalogModel[]): void {
  const data: CatalogResult = {
    models,
    throttledModels: [],
    probedAt: new Date().toISOString(),
    providers: [...new Set(models.map((m) => m.provider))],
  };
  seedCatalogForTests(data);
}

/** Minimal window/sessionStorage stub — background-chat guards at call time. */
function installFakeSessionStorage(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => {},
  };
}

beforeEach(() => {
  // Nukes the memory cache AND the on-disk catalog copy — a stale disk cache
  // would otherwise answer getVerifiedModels instead of the seeded one.
  resetModelCatalogForTests();
  clearTaskSnapshot();
});

afterEach(() => {
  // Never leave a task behind: its cleanup timers would fire into a later test.
  cancelTask();
  clearTaskSnapshot();
  delete (globalThis as Record<string, unknown>).window;
});

describe("pickRetryModel", () => {
  it("returns the next verified model, excluding the failed one", async () => {
    seed([model("a/first"), model("b/second"), model("c/third")]);
    await expect(pickRetryModel(["a/first"], "a/first")).resolves.toBe("b/second");
  });

  it("never returns the current model even when the failed list omits it", async () => {
    seed([model("a/first"), model("b/second")]);
    await expect(pickRetryModel([], "b/second")).resolves.toBe("a/first");
    await expect(pickRetryModel(["b/second"], "b/second:free")).resolves.toBe("a/first");
  });

  it("prefers freshly verified (green) models over stale ones", async () => {
    seed([
      model("amber/stale"), // no lastVerifiedAt → amber
      model("green/fresh", { lastVerifiedAt: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    await expect(pickRetryModel(["gone/failed"], "gone/failed")).resolves.toBe("green/fresh");
  });

  it("treats bare-id and :free variants as the same pick when excluding", async () => {
    seed([model("vendor/x:free"), model("vendor/y")]);
    // The picker's saved key may lack the :free suffix the catalog carries.
    await expect(pickRetryModel(["vendor/x:free"], "vendor/x")).resolves.toBe("vendor/y");
    // And the reverse: the failure trail carries the BARE id (worker task
    // stamps) while the catalog lists the :free slug — the failed model must
    // still be excluded, never handed back as the "next" pick.
    await expect(pickRetryModel(["vendor/x"], null)).resolves.toBe("vendor/y");
  });

  it("returns null when everything verified has failed", async () => {
    seed([model("a/only"), model("b/also")]);
    await expect(pickRetryModel(["a/only", "b/also"], "a/only")).resolves.toBeNull();
  });

  it("returns null on an empty catalog rather than inventing a model", async () => {
    seed([]);
    await expect(pickRetryModel(["a/first"], "a/first")).resolves.toBeNull();
  });
});

describe("startTask model stamping", () => {
  it("stamps the selected model onto the live task", () => {
    startTask(null, "do the thing", [], "code", "vendor/m");
    expect(getCurrentTask()?.model).toBe("vendor/m");
  });

  it("omits the model field when none was selected", () => {
    startTask(null, "do the thing", [], "code");
    const task = getCurrentTask();
    expect(task).not.toBeNull();
    expect("model" in (task as object)).toBe(false);
  });

  it("carries the model into the reload snapshot", () => {
    installFakeSessionStorage();
    startTask("convo-1", "do the thing", [], "code", "vendor/m");
    persistTaskSnapshot(true);
    const snap = readTaskSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.model).toBe("vendor/m");
    expect(snap?.conversationId).toBe("convo-1");
  });

  it("leaves the snapshot model unset when none was selected", () => {
    installFakeSessionStorage();
    startTask("convo-1", "do the thing", [], "code");
    persistTaskSnapshot(true);
    expect(readTaskSnapshot()?.model).toBeUndefined();
  });
});
