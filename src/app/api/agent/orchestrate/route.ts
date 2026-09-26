// /api/agent/orchestrate — server-side entry point for the deep orchestration
// modules (SPARC, tree-of-thoughts, blueprint, swarm). These run on the
// server because their transports (blueprint →
// provider adapter) need API keys that must never reach the browser.
//
// The route NEVER touches the filesystem — it returns model output. The
// client-side background worker owns every write, so approvals, file history,
// and undo keep working unchanged.
//
// POST body: { op: "sparc" | "tot" | "blueprint" | "swarm-review" | "plan", task, context?, files? }
// Responses:
//   sparc         → { ok, status, summary, toolCalls: ToolCall[] }
//   tot           → { ok, winner: { name, score, reason }, toolCalls, branches: [{name, score}] }
//   blueprint     → { ok, projectName, toolCalls }
//   swarm-review  → { ok, review, tests, consensus }
//   plan          → { ok, plan: ExecutionPlan }

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FILES = 12;
const MAX_TASK_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_FILE_CHARS = 8_000;

function clamp(s: string | undefined, max: number): string {
  const t = (s || "").slice(0, max);
  return t.length < (s || "").length ? t + "\n…[truncated]" : t;
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const op = String(body.op || "");
  const task = clamp(body.task, MAX_TASK_CHARS);
  if (!op || !task) {
    return NextResponse.json({ ok: false, error: "op and task are required" }, { status: 400 });
  }
  const context = clamp(body.context, MAX_CONTEXT_CHARS);

  try {
    switch (op) {
      case "sparc": {
        const { runSPARC, getSPARCSummary } = await import("@/lib/sparc");
        const sparcTask = await runSPARC(task);
        // The refinement phase's raw model output carries <tool_call> JSON —
        // surface it so the worker can execute the writes itself.
        const refinePhase = sparcTask.phases.find(p => p.phase === "refinement");
        const toolCalls =
          refinePhase && refinePhase.success
            ? (await import("@/lib/stream-reader")).parseToolCalls(refinePhase.output)
            : [];
        const files = toolCalls
          .filter(tc => tc.name === "write_file" && tc.path)
          .map(tc => tc.path!);
        return NextResponse.json({
          ok: true,
          status: sparcTask.status,
          summary: getSPARCSummary(sparcTask),
          toolCalls,
          files,
        });
      }

      case "tot": {
        const { runTreeOfThoughts } = await import("@/lib/tree-of-thoughts");
        const result = await runTreeOfThoughts(
          task,
          async (messages) => {
            const { createProviderAdapter } = await import("@/lib/ai-providers");
            return createProviderAdapter().complete(messages);
          },
          3
        );
        // Convert the winning branch's files into write_file tool calls so the
        // worker executes them through its normal audited path.
        const toolCalls = result.winner.files.map(f => ({
          name: "write_file",
          path: f.path,
          content: f.content,
        }));
        return NextResponse.json({
          ok: true,
          winner: { name: result.winner.name, score: result.winner.score, reason: result.reason },
          toolCalls,
          branches: result.branches.map(b => ({ name: b.name, score: b.score })),
        });
      }

      case "blueprint": {
        const bp = await import("@/lib/blueprint-pattern");
        const blueprint = await bp.generateBlueprint(task, context);
        const skeletons = await bp.generateSkeletons(blueprint, context);
        // Files that got real implementations become write_file calls;
        // unresolved skeletons are skipped (the worker continues in normal mode).
        const toolCalls = skeletons
          .filter(s => s.content && s.content.trim().length > 0 && !s.content.startsWith("// TODO"))
          .slice(0, MAX_FILES)
          .map(s => ({ name: "write_file", path: s.path, content: s.content }));
        return NextResponse.json({
          ok: true,
          projectName: blueprint.projectName,
          description: blueprint.description,
          toolCalls,
          files: toolCalls.map(tc => tc.path),
        });
      }

      case "swarm-review": {
        const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
        if (files.length === 0) {
          return NextResponse.json({ ok: false, error: "files[] required for swarm-review" }, { status: 400 });
        }
        const fileContext = files
          .map((f: { path: string; content: string }) =>
            `--- ${f.path} ---\n${clamp(f.content, MAX_FILE_CHARS)}`)
          .join("\n\n");
        const { swarmCodeAndReview } = await import("@/lib/swarm");
        const out = await swarmCodeAndReview(task, fileContext);
        return NextResponse.json({
          ok: true,
          review: clamp(out.review, MAX_FILE_CHARS),
          tests: clamp(out.tests, MAX_FILE_CHARS),
          consensus: out.consensus,
        });
      }

      case "plan": {
        // The langchain-orchestrator behind this op was removed (aspirational
        // module — its plans referenced tools that never executed). Planning
        // is the worker's SPARC plan-first directive now.
        return NextResponse.json(
          { ok: false, error: "op 'plan' removed — use the worker's built-in plan-first flow" },
          { status: 410 }
        );
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
