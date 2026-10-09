// playbook.test.ts — Evidence-gated learning loop (Track A).
//
// Covers: the verified-run gate (unverified runs derive nothing), the
// merge/boost path (repeated evidence raises confidence, capped at 1.0),
// the contradiction/decay path, score-gated retrieval, and the prompt
// formatter. Prisma + embeddings are mocked — no DB, no model download.

type Row = {
  id: string;
  projectId: string;
  pattern: string;
  content: string;
  tags: string[];
  sourceRunId: string | null;
  confidence: number;
  verified: boolean;
  useCount: number;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const store = new Map<string, Row>();
let seq = 0;

jest.mock("../prisma", () => ({
  prisma: {
    learning: {
      findFirst: jest.fn(async ({ where }: any) => {
        for (const r of store.values()) {
          if (where.projectId && r.projectId !== where.projectId) continue;
          if (where.pattern && r.pattern !== where.pattern) continue;
          if (where.id && r.id !== where.id) continue;
          return { ...r };
        }
        return null;
      }),
      // Honors skip/take like real Prisma: the cap-check query passes
      // skip: MAX (overflow rows only). A mock that ignores skip would
      // return every row and the cap check would delete the whole store.
      findMany: jest.fn(async ({ where, take, skip }: any) => {
        const all: Row[] = [];
        for (const r of store.values()) {
          if (where?.projectId && r.projectId !== where.projectId) continue;
          all.push({ ...r });
        }
        const sliced = typeof skip === "number" ? all.slice(skip) : all;
        return typeof take === "number" ? sliced.slice(0, take) : sliced;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          id: `pb-${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.set(row.id, row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cur = store.get(where.id);
        if (!cur) throw new Error("not found");
        const next: Row = { ...cur, updatedAt: new Date() };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            (next as any)[k] = (cur as any)[k] + (v as any).increment;
          } else {
            (next as any)[k] = v;
          }
        }
        store.set(next.id, next);
        return { ...next };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        if (where?.id?.in) {
          for (const id of where.id.in as string[]) {
            if (store.delete(id)) count++;
          }
        } else {
          for (const [id, r] of store) {
            if (where?.id && r.id !== where.id) continue;
            if (where?.projectId && r.projectId !== where.projectId) continue;
            store.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
  },
}));

// Embeddings disabled by default (lexical path); enabled per-test.
let mockTaskVec: Float32Array | null = null;
jest.mock("../embeddings", () => ({
  embedText: async (_t: string) => mockTaskVec,
  cosineSimilarity: (a: ArrayLike<number> | null, b: ArrayLike<number> | null): number => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));

import {
  deriveFromRun,
  mergeOrCreate,
  searchPlaybooks,
  formatPlaybooksForPrompt,
  updatePlaybook,
  deletePlaybook,
  listPlaybooks,
} from "../playbook";

beforeEach(() => {
  store.clear();
  seq = 0;
  mockTaskVec = null;
});

const verifiedFiles = {
  "src/app/playbook/page.tsx": "export default function PlaybookPage() {}",
  "src/app/api/playbook/route.ts": "export async function GET() {}",
};

describe("deriveFromRun — the verified-run gate", () => {
  it("refuses to learn from unverified runs", () => {
    expect(
      deriveFromRun({ task: "build x", files: verifiedFiles, lanes: { typecheck: "fail" }, finalStatus: "done" })
    ).toEqual([]);
  });

  it("refuses to learn from skipped lanes", () => {
    expect(
      deriveFromRun({ task: "build x", files: verifiedFiles, lanes: { typecheck: "skipped" }, finalStatus: "done" })
    ).toEqual([]);
  });

  it("refuses to learn from failed tasks even with passing lanes", () => {
    expect(
      deriveFromRun({ task: "build x", files: verifiedFiles, lanes: { typecheck: "pass" }, finalStatus: "error" })
    ).toEqual([]);
  });

  it("derives nothing when no files were written", () => {
    expect(
      deriveFromRun({ task: "answer q", files: {}, lanes: { typecheck: "pass" }, finalStatus: "done" })
    ).toEqual([]);
  });

  it("derives entries from a verified run with files", () => {
    const out = deriveFromRun({
      task: "build the playbook page",
      files: verifiedFiles,
      lanes: { typecheck: "pass" },
      finalStatus: "done",
    });
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.content.length).toBeGreaterThan(0);
      expect(e.pattern.length).toBeGreaterThan(0);
    }
  });
});

describe("mergeOrCreate — evidence merging", () => {
  it("creates a new entry at 0.5 confidence", async () => {
    const e = await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    });
    expect(e).not.toBeNull();
    expect(e!.confidence).toBe(0.5);
    expect(e!.useCount).toBe(1);
  });

  it("boosts confidence and useCount on repeated identical evidence", async () => {
    const input = {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    };
    await mergeOrCreate("default", input);
    const second = await mergeOrCreate("default", input);
    expect(second!.confidence).toBeCloseTo(0.6);
    expect(second!.useCount).toBe(2);
  });

  it("caps confidence at 1.0", async () => {
    const input = {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    };
    let cur = await mergeOrCreate("default", input);
    for (let i = 0; i < 10; i++) cur = await mergeOrCreate("default", input);
    expect(cur!.confidence).toBeLessThanOrEqual(1.0);
  });

  it("boosts the matching row on flip-flopping evidence instead of growing rows", async () => {
    const a = {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    };
    const b = {
      pattern: "stack",
      content: "This workspace uses Vue.",
      tags: ["stack"],
      evidence: {},
    };
    await mergeOrCreate("default", a);
    await mergeOrCreate("default", b); // contradicts: decays Next.js, stores Vue
    const third = await mergeOrCreate("default", a); // Next.js again: must boost, not create
    const rows = await listPlaybooks("default");
    expect(rows).toHaveLength(2);
    expect(third!.confidence).toBeGreaterThan(0.5);
    expect(third!.useCount).toBe(2);
  });

  it("decays the old entry on contradicting evidence and stores the new one", async () => {
    await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    });
    const contradicted = await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Vue.",
      tags: ["stack"],
      evidence: {},
    });
    expect(contradicted).not.toBeNull();
    // The decayed row is still in the store with lowered confidence.
    const rows = await listPlaybooks("default");
    const decayed = rows.find((r) => r.content.includes("Next.js"));
    expect(decayed!.confidence).toBeLessThan(0.5);
  });
});

describe("searchPlaybooks — gated retrieval", () => {
  it("returns [] for an empty task (no full-table injection)", async () => {
    await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    });
    expect(await searchPlaybooks("default", "", 5)).toEqual([]);
    expect(await searchPlaybooks("default", "   ", 5)).toEqual([]);
  });

  it("returns [] when the store is empty", async () => {
    expect(await searchPlaybooks("default", "build a page", 5)).toEqual([]);
  });

  it("retrieves lexically matching entries, best score first", async () => {
    await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    });
    await mergeOrCreate("default", {
      pattern: "file-layout",
      content: "Recent verified work writes src/components/ files.",
      tags: ["layout"],
      evidence: {},
    });
    const hits = await searchPlaybooks("default", "next.js components", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[hits.length - 1].score);
    expect(hits.length).toBeLessThanOrEqual(5);
  });
});

describe("formatPlaybooksForPrompt", () => {
  it("returns null when there is nothing to inject", () => {
    expect(formatPlaybooksForPrompt([])).toBeNull();
  });

  it("renders a ## PLAYBOOK block with confidence", () => {
    const out = formatPlaybooksForPrompt([
      { id: "1", pattern: "stack", content: "Uses Next.js.", tags: [], confidence: 0.7, score: 2 },
    ]);
    expect(out).toContain("## PLAYBOOK");
    expect(out).toContain("Uses Next.js.");
    expect(out).toContain("70%");
  });
});

describe("loop closure — a past learning appears in a later prompt", () => {
  it("injects ## PLAYBOOK into the system prompt for a matching task", async () => {
    // A previous verified run merged this learning...
    await mergeOrCreate("default", {
      pattern: "stack",
      content: "This workspace uses Next.js.",
      tags: ["stack"],
      evidence: {},
    });
    // ...so a later matching task gets it in the prompt.
    const { buildSystemPrompt } = await import("../master-prompt");
    const prompt = await buildSystemPrompt({
      mode: "code",
      task: "Build a new page — our stack uses Next.js",
    });
    expect(prompt).toContain("## PLAYBOOK");
    expect(prompt).toContain("This workspace uses Next.js.");
  });

  it("injects nothing when nothing matches", async () => {
    const { buildSystemPrompt } = await import("../master-prompt");
    const prompt = await buildSystemPrompt({ mode: "code", task: "Fix the toaster" });
    expect(prompt).not.toContain("## PLAYBOOK");
  });
});

describe("update/delete", () => {
  it("pins an entry and deletes it", async () => {
    const e = await mergeOrCreate("default", {
      pattern: "skill",
      content: "deploy: run npm run build first",
      tags: ["skill"],
      evidence: {},
    });
    const pinned = await updatePlaybook(e!.id, "default", { pinned: true });
    expect(pinned!.pinned).toBe(true);
    // The list path (what the UI renders) must reflect the pin.
    const listed = await listPlaybooks("default");
    expect(listed.find((r) => r.id === e!.id)?.pinned).toBe(true);
    expect(await deletePlaybook(e!.id, "default")).toBe(true);
    expect(await listPlaybooks("default")).toEqual([]);
  });

  it("returns null/false for unknown ids", async () => {
    expect(await updatePlaybook("nope", "default", { pinned: true })).toBeNull();
    expect(await deletePlaybook("nope", "default")).toBe(false);
  });
});
