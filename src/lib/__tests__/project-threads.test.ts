/**
 * project-threads.test.ts — the Projects sidebar's pure grouping rules:
 * per-project filtering/ordering/cap, the Ungrouped bucket, History-page
 * filter matching (incl. the __ungrouped__ sentinel), and link/query helpers.
 */
import {
  projectLabel,
  threadsForProject,
  ungroupedThreads,
  matchesWorkspaceFilter,
  historyLinkFor,
  workspaceFromQuery,
  type ThreadLike,
} from "../project-threads";

const t = (id: string, workspaceName: string | null, updatedAt: string, title = id): ThreadLike => ({
  id,
  title,
  updatedAt,
  workspaceName,
});

const THREADS: ThreadLike[] = [
  t("a1", "orplex", "2026-09-20T10:00:00Z"),
  t("a2", "orplex", "2026-09-25T10:00:00Z"),
  t("a3", "orplex", "2026-09-22T10:00:00Z"),
  t("a4", "orplex", "2026-09-23T10:00:00Z"),
  t("a5", "orplex", "2026-09-24T10:00:00Z"),
  t("a6", "orplex", "2026-09-26T10:00:00Z"), // 6th — beyond the cap
  t("b1", "logo", "2026-09-21T10:00:00Z"),
  t("u1", null, "2026-09-19T10:00:00Z"),
  t("u2", null, "2026-09-27T10:00:00Z"),
];

describe("threadsForProject", () => {
  it("filters by exact workspaceName, newest first, capped at 5", () => {
    const rows = threadsForProject(THREADS, "orplex");
    expect(rows.map((r) => r.id)).toEqual(["a6", "a2", "a5", "a4", "a3"]); // a1 dropped (oldest)
  });

  it("respects a custom limit", () => {
    expect(threadsForProject(THREADS, "orplex", 2).map((r) => r.id)).toEqual(["a6", "a2"]);
  });

  it("returns [] for a project with no threads", () => {
    expect(threadsForProject(THREADS, "new camera")).toEqual([]);
  });

  it("name matching is exact (no prefix/suffix bleed)", () => {
    const tricky: ThreadLike[] = [t("x", "orplex-two", "2026-09-01T00:00:00Z")];
    expect(threadsForProject(tricky, "orplex")).toEqual([]);
  });
});

describe("ungroupedThreads", () => {
  it("collects untagged threads, newest first", () => {
    expect(ungroupedThreads(THREADS).map((r) => r.id)).toEqual(["u2", "u1"]);
  });
});

describe("projectLabel", () => {
  it("prefers a non-blank alias, falls back to the folder name", () => {
    expect(projectLabel("orplex", "My Repo")).toBe("My Repo");
    expect(projectLabel("orplex", "   ")).toBe("orplex");
    expect(projectLabel("orplex", null)).toBe("orplex");
  });

  it("renders Ungrouped for null/undefined names", () => {
    expect(projectLabel(null)).toBe("Ungrouped");
    expect(projectLabel(undefined)).toBe("Ungrouped");
  });
});

describe("matchesWorkspaceFilter (History page)", () => {
  it("no filter → everything matches", () => {
    expect(matchesWorkspaceFilter(THREADS[0], null)).toBe(true);
  });

  it("named filter matches only that workspace", () => {
    expect(matchesWorkspaceFilter(THREADS[0], "orplex")).toBe(true);
    expect(matchesWorkspaceFilter(THREADS[6], "orplex")).toBe(false);
  });

  it("__ungrouped__ sentinel matches only untagged threads", () => {
    expect(matchesWorkspaceFilter(THREADS[7], "__ungrouped__")).toBe(true);
    expect(matchesWorkspaceFilter(THREADS[0], "__ungrouped__")).toBe(false);
  });
});

describe("historyLinkFor / workspaceFromQuery", () => {
  it("builds and parses the round trip, encoding odd names", () => {
    expect(historyLinkFor("orplex")).toBe("/history?workspace=orplex");
    expect(historyLinkFor("new camera")).toBe("/history?workspace=new%20camera");
    expect(historyLinkFor(null)).toBe("/history?workspace=__ungrouped__");

    expect(workspaceFromQuery("?workspace=orplex")).toBe("orplex");
    expect(workspaceFromQuery("?workspace=new%20camera")).toBe("new camera");
    expect(workspaceFromQuery("?workspace=__ungrouped__")).toBe("__ungrouped__");
    expect(workspaceFromQuery("")).toBeNull();
    expect(workspaceFromQuery("?workspace=%20%20")).toBeNull(); // whitespace-only → null
  });
});
