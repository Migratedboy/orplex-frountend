// strategy-router.ts — ONE deterministic orchestration layer.
//
// Replaces five modules (sparc.ts 439L, tree-of-thoughts.ts 132L,
// swarm.ts 429L, blueprint-pattern.ts 287L, m3-client.ts 125L = 1,412 lines)
// with ~300 that do the same job with fewer moving parts:
//
//   Old: SPARC 5-phase gate waterfall → ToT branch race → Blueprint scaffold,
//        each with its own hardcoded NVIDIA transport (m3-client), its own
//        JSON gates that could silently fail and fall through the waterfall,
//        plus a swarm of 3 "agents" for review. Multiple model calls per
//        plan, verdicts from self-graded heuristics, transport outside the
//        circuit breaker / TPM pacer.
//
//   New: one transport (the provider registry adapter — inherits retry,
//        circuit breaker, TPM pacing, failover) + FOUR pure strategy
//        functions, each producing { summary, toolCalls } that the caller
//        (worker / server executor) executes through its own audited write
//        path. ONE deterministic router picks the strategy from task shape —
//        no meta-LLM, no phase gates, no branch voting.
//
// Cost profile: exactly ONE model call per plan (was up to 5), review stays
// one call. Zero behavior the caller has to migrate: same response shapes
// the orchestrate route already returned.

import { createProviderAdapter, type AIProviderAdapter } from "./ai-providers";
import { analyzeCodeQuality } from "./code-quality-checker";
import { parseToolCalls } from "./stream-reader";

// === Types ==================================================================

export type StrategyKind = "plan" | "implement" | "branch-compare" | "scaffold" | "review";

export interface StrategyToolCall {
  name: string;
  path?: string;
  content?: string;
  [k: string]: unknown;
}

export interface StrategyResult {
  ok: boolean;
  strategy: StrategyKind;
  /** Human-readable plan/output summary for the transcript. */
  summary: string;
  /** write_file calls the caller executes through the audited path. */
  toolCalls: StrategyToolCall[];
  /** Paths the strategy plans to write (from toolCalls). */
  files: string[];
  /** Review-only: consensus verdict (true = no blocking findings). */
  consensus?: boolean;
  error?: string;
}

export interface RouterContext {
  task: string;
  /** Existing workspace context (file tree, snippets) if any. */
  context?: string;
  /** Number of files already in the workspace — scaffold detection. */
  existingFileCount?: number;
  /** Per-run model override (BYOK frontier mode). */
  modelOverride?: string | null;
}

// === Transport ==============================================================

/** One buffered completion via the registry adapter (retry + breaker built in). */
async function complete(modelOverride: string | null | undefined, messages: Array<{ role: string; content: string }>): Promise<string> {
  const adapter: AIProviderAdapter = createProviderAdapter(modelOverride ?? undefined);
  return adapter.complete(messages);
}

/** Extract a JSON object from a model response that may wrap it in prose/fences. */
function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// === Strategy: plan (collapsed SPARC spec→pseudo→arch) ======================

interface PlanShape {
  goal?: string;
  requirements?: Array<{ description?: string } | string>;
  files?: Array<{ path?: string; purpose?: string; content?: string }>;
  order?: string[];
}

/**
 * PLAN: one call produces the spec (goal/requirements) AND the concrete file
 * plan with full contents. The old SPARC spent 4 calls + 3 gates to reach the
 * same artifact; the gate results were never consumed downstream.
 */
export async function strategyPlan(ctx: RouterContext): Promise<StrategyResult> {
  try {
    const raw = await complete(ctx.modelOverride, [
      {
        role: "system",
        content:
          "You are a senior software architect. Plan the implementation precisely. " +
          "Return ONLY JSON (no prose outside it):\n" +
          '{"goal": string, "requirements": string[], "files": [{"path": string, "purpose": string, "content": string}], "order": string[]}\n' +
          "Rules: 2-8 files max; every file gets COMPLETE working content (no TODOs, no placeholders); " +
          "import paths consistent; respect the existing stack visible in the context.",
      },
      {
        role: "user",
        content: `${ctx.context ? `Existing workspace context:\n${ctx.context.slice(0, 6000)}\n\n` : ""}Task: ${ctx.task}`,
      },
    ]);
    const plan = extractJson<PlanShape>(raw);
    const files = (Array.isArray(plan?.files) ? plan!.files : []).filter(
      (f): f is { path: string; purpose?: string; content?: string } =>
        !!f && typeof f.path === "string" && typeof f.content === "string" && f.content.trim().length > 0,
    );
    if (files.length === 0) {
      return { ok: false, strategy: "plan", summary: "Planning produced no concrete files.", toolCalls: [], files: [], error: "plan-empty" };
    }
    const reqCount = Array.isArray(plan?.requirements) ? plan!.requirements.length : 0;
    const toolCalls: StrategyToolCall[] = files.slice(0, 12).map((f) => ({ name: "write_file", path: f.path, content: f.content! }));
    return {
      ok: true,
      strategy: "plan",
      summary:
        `Goal: ${plan?.goal || "implement the task"} — ${reqCount} requirement(s), ` +
        `${toolCalls.length} file(s) planned${Array.isArray(plan?.order) && plan!.order.length ? ` (build order: ${plan!.order.slice(0, 6).join(" → ")})` : ""}.`,
      toolCalls,
      files: toolCalls.map((t) => t.path!),
    };
  } catch (err) {
    return { ok: false, strategy: "plan", summary: "", toolCalls: [], files: [], error: String((err as Error)?.message || err) };
  }
}

// === Strategy: implement (single focused write; the old default path) =======

/**
 * IMPLEMENT: one call writes the files for a task without a planning phase.
 * Used for mid-complexity tasks where a plan document adds latency, not value.
 */
export async function strategyImplement(ctx: RouterContext): Promise<StrategyResult> {
  try {
    const raw = await complete(ctx.modelOverride, [
      {
        role: "system",
        content:
          "You are a senior developer. Implement the task directly. " +
          'For EVERY file you create, emit one tool call in this exact format:\n<tool_call>{"name":"write_file","path":"rel/path.ts","content":"full file content"}</tool_call>\n' +
          "Complete working code only. 1-4 files. No prose between tool calls.",
      },
      {
        role: "user",
        content: `${ctx.context ? `Existing workspace context:\n${ctx.context.slice(0, 6000)}\n\n` : ""}Task: ${ctx.task}`,
      },
    ]);
    const parsed = parseToolCalls(raw) as unknown as StrategyToolCall[];
    const writes = parsed.filter((t) => t.name === "write_file" && t.path && typeof t.content === "string" && t.content.trim());
    if (writes.length === 0) {
      return { ok: false, strategy: "implement", summary: "Implementation produced no files.", toolCalls: [], files: [], error: "implement-empty" };
    }
    return {
      ok: true,
      strategy: "implement",
      summary: `Implemented ${writes.length} file(s): ${writes.map((w) => w.path).join(", ")}.`,
      toolCalls: writes.slice(0, 8),
      files: writes.map((w) => w.path!),
    };
  } catch (err) {
    return { ok: false, strategy: "implement", summary: "", toolCalls: [], files: [], error: String((err as Error)?.message || err) };
  }
}

// === Strategy: branch-compare (collapsed ToT; UI/ambiguous tasks only) ======

const BRANCH_LENSES = [
  { id: "functional", name: "Functional hooks", suffix: "Use functional components with hooks; extract reusable custom hooks; useCallback/useMemo where it matters." },
  { id: "modular", name: "Modular architecture", suffix: "Separate concerns into modules (types/utils/hooks/components); max ~100 lines per file." },
  { id: "production", name: "Production-grade", suffix: "Full error handling, loading states, strict TypeScript (no any), ARIA labels, responsive design." },
] as const;

/**
 * BRANCH-COMPARE: generate 2-3 variant implementations in parallel, score with
 * the existing static analyzer (deterministic — no LLM judge), keep the best.
 * The old ToT shipped the winner's files as write calls; so does this — the
 * difference is it only runs when the router says ambiguity is real.
 */
export async function strategyBranchCompare(ctx: RouterContext, maxBranches = 3): Promise<StrategyResult> {
  const lenses = BRANCH_LENSES.slice(0, maxBranches);
  const settled = await Promise.all(
    lenses.map(async (lens) => {
      try {
        const raw = await complete(ctx.modelOverride, [
          { role: "system", content: `You are a senior developer. ${lens.suffix}` },
          {
            role: "user",
            content: `${ctx.context ? `Existing workspace context:\n${ctx.context.slice(0, 4000)}\n\n` : ""}Build the following. Approach: ${lens.suffix}\n\n${ctx.task}\n\nEmit every file as:\n<tool_call>{"name":"write_file","path":"rel/path.ts","content":"full content"}</tool_call>`,
          },
        ]);
        const writes = (parseToolCalls(raw) as unknown as StrategyToolCall[]).filter(
          (t) => t.name === "write_file" && t.path && typeof t.content === "string" && t.content.trim(),
        );
        const score = writes.length === 0
          ? 0
          : writes.reduce((s, w) => s + analyzeCodeQuality(w.path!, w.content!).score, 0) / writes.length;
        return { lens, writes, score };
      } catch {
        return { lens, writes: [] as StrategyToolCall[], score: 0 };
      }
    }),
  );

  const best = settled.reduce((a, b) => (b.score > a.score ? b : a), settled[0]);
  if (!best || best.writes.length === 0) {
    return { ok: false, strategy: "branch-compare", summary: "", toolCalls: [], files: [], error: "all-branches-empty" };
  }
  return {
    ok: true,
    strategy: "branch-compare",
    summary: `Branches: ${settled.map((s) => `${s.lens.name} ${s.score.toFixed(0)}`).join(", ")}. Winner: ${best.lens.name} (static quality ${best.score.toFixed(0)}/100).`,
    toolCalls: best.writes.slice(0, 8),
    files: best.writes.map((w) => w.path!),
  };
}

// === Strategy: scaffold (collapsed blueprint; greenfield multi-file) ========

/**
 * SCAFFOLD: one call lays out the whole project structure with working file
 * contents (the old blueprint did JSON-plan → skeleton → implement per file —
 * 2+ calls and TODO stubs that needed a second pass).
 */
export async function strategyScaffold(ctx: RouterContext): Promise<StrategyResult> {
  try {
    const raw = await complete(ctx.modelOverride, [
      {
        role: "system",
        content:
          "You are a project scaffolder. Lay out the complete file structure for this project. " +
          'For EVERY file emit one tool call: <tool_call>{"name":"write_file","path":"rel/path.ts","content":"complete working content"}</tool_call>\n' +
          "5-10 files. Entry points first in the message. No TODOs.",
      },
      {
        role: "user",
        content: `${ctx.context ? `Existing workspace context:\n${ctx.context.slice(0, 6000)}\n\n` : ""}Project: ${ctx.task}`,
      },
    ]);
    const writes = (parseToolCalls(raw) as unknown as StrategyToolCall[]).filter(
      (t) => t.name === "write_file" && t.path && typeof t.content === "string" && t.content.trim(),
    );
    if (writes.length === 0) {
      return { ok: false, strategy: "scaffold", summary: "", toolCalls: [], files: [], error: "scaffold-empty" };
    }
    return {
      ok: true,
      strategy: "scaffold",
      summary: `Scaffolded ${writes.length} file(s): ${writes.slice(0, 5).map((w) => w.path).join(", ")}${writes.length > 5 ? ", …" : ""}.`,
      toolCalls: writes.slice(0, 12),
      files: writes.map((w) => w.path!),
    };
  } catch (err) {
    return { ok: false, strategy: "scaffold", summary: "", toolCalls: [], files: [], error: String((err as Error)?.message || err) };
  }
}

// === Strategy: review (collapsed swarm) =====================================

export interface ReviewFinding {
  severity: "critical" | "major" | "minor";
  description: string;
}

/**
 * REVIEW: ONE reviewer pass over the written files with a severity contract.
 * The old swarm spawned 3 "agents" (coder/reviewer/tester) and merged their
 * text by consensus heuristics; a single structured review catches the same
 * blocking findings for a third of the tokens. consensus=false → the caller
 * feeds the findings into one repair turn.
 */
export async function strategyReview(
  files: Array<{ path: string; content: string }>,
  task: string,
  modelOverride?: string | null
): Promise<StrategyResult & { findings?: ReviewFinding[] }> {
  const fileContext = files
    .slice(0, 8)
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6000)}`)
    .join("\n\n");
  try {
    const raw = await complete(modelOverride, [
      {
        role: "system",
        content:
          "You are a code reviewer. Review the files against the task. Return ONLY JSON:\n" +
          '{"findings": [{"severity": "critical|major|minor", "description": string}]}\n' +
          "critical = broken behavior/security/data loss. major = likely bug or missing requirement. " +
          "minor = style. Empty findings array when the code is correct.",
      },
      { role: "user", content: `Task: ${task.slice(0, 1000)}\n\n${fileContext}` },
    ]);
    const parsed = extractJson<{ findings?: Array<{ severity?: string; description?: string }> }>(raw);
    const findings: ReviewFinding[] = (Array.isArray(parsed?.findings) ? parsed!.findings : [])
      .map((f) => ({
        severity: (f?.severity === "critical" || f?.severity === "major" || f?.severity === "minor" ? f.severity : "minor") as ReviewFinding["severity"],
        description: String(f?.description || "").slice(0, 300),
      }))
      .filter((f) => f.description);
    const blocking = findings.filter((f) => f.severity !== "minor");
    return {
      ok: true,
      strategy: "review",
      summary:
        blocking.length === 0
          ? `Review clean — ${findings.length} minor note(s).`
          : `${blocking.length} blocking finding(s): ${blocking.slice(0, 3).map((f) => f.description.slice(0, 80)).join("; ")}`,
      toolCalls: [],
      files: [],
      consensus: blocking.length === 0,
      findings,
    };
  } catch (err) {
    return { ok: false, strategy: "review", summary: "", toolCalls: [], files: [], consensus: true, error: String((err as Error)?.message || err) };
  }
}

// === The deterministic router ==============================================

/** Multi-file greenfield signals: "build/create an app/site/dashboard/system…". */
const GREENFIELD_RE = /\b(build|create|make|generate|scaffold|set\s?up)\b[^.!?]{0,80}\b(app|application|website|site|dashboard|platform|system|project|clone|landing|portfolio|api)\b/i;
/** UI/ambiguity signals where variant comparison pays for itself. */
const UI_AMBIGUOUS_RE = /\b(component|page|widget|card|form|modal|layout|landing|hero|pricing|dashboard)\b/i;

/**
 * Pick the strategy from task shape. Deterministic: same task + same workspace
 * state → same strategy. No model call is spent deciding.
 *
 *   scaffold        greenfield multi-file build (many new files, little existing code)
 *   branch-compare  UI-shaped task where style variants are worth comparing
 *   implement       everything else with a concrete implementable shape
 *   plan            reserved: only forced when callers ask for it explicitly
 */
export function pickStrategy(ctx: RouterContext): Exclude<StrategyKind, "review"> {
  const t = ctx.task || "";
  const fileCount = ctx.existingFileCount ?? 0;
  const greenfield = GREENFIELD_RE.test(t);
  const uiAmbiguous = UI_AMBIGUOUS_RE.test(t);

  if (greenfield && fileCount < 12) return "scaffold";
  if (uiAmbiguous && fileCount > 0) return "branch-compare";
  // Complex multi-requirement tasks still benefit from an explicit file plan
  // even when not greenfield (refactors with new modules, feature additions).
  const multiRequirement = t.split(/\n|\.|;|\band\b/i).filter((s) => s.trim().length > 10).length >= 5;
  if (multiRequirement && greenfield) return "plan";
  return "implement";
}

/**
 * Run the routed strategy. This is the ONE entry callers use; `kind` forces a
 * specific strategy when the caller already knows better (e.g. the exec route
 * exposing explicit ops).
 */
export async function runStrategy(
  ctx: RouterContext,
  kind?: StrategyKind
): Promise<StrategyResult> {
  const chosen = kind ?? pickStrategy(ctx);
  switch (chosen) {
    case "plan": return strategyPlan(ctx);
    case "implement": return strategyImplement(ctx);
    case "branch-compare": return strategyBranchCompare(ctx);
    case "scaffold": return strategyScaffold(ctx);
    case "review":
      // Review needs files; without them there is nothing to review. Callers
      // use strategyReview() directly — this arm only normalizes misuse.
      return { ok: false, strategy: "review", summary: "", toolCalls: [], files: [], error: "review requires files — use strategyReview()" };
  }
}

/** One-line capability blurb for the master prompt's tool roster. */
export function describeStrategies(): string {
  return "Planning strategies (routed automatically by task shape): scaffold (greenfield builds), branch-compare (UI variants, best wins by static quality), implement (direct writes), plan (spec + file plan). Review runs once post-write with a severity contract.";
}
