// /api/agent/orchestrate — server-side entry for the deterministic strategy
// router (src/lib/strategy-router.ts), which replaced the five former
// orchestration modules (SPARC / ToT / blueprint / swarm / m3-client).
//
// The route NEVER touches the filesystem — it returns model output. The
// client-side background worker owns every write, so approvals, file history,
// and undo keep working unchanged.
//
// POST body: { op: "plan" | "implement" | "branch-compare" | "scaffold" |
//              "review" | "auto", task, context?, files?, existingFileCount?, model? }
// Responses:
//   plan / implement / branch-compare / scaffold → { ok, strategy, summary, toolCalls, files }
//   review        → { ok, consensus, review, findings }
//   auto          → the router picks the strategy from task shape
//
// Legacy op names ("sparc", "tot", "blueprint", "swarm-review") map onto the
// closest new strategy so any queued client keeps working during the window
// a deployed frontend lags the backend.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { runStrategy, strategyReview } from "@/lib/strategy-router";

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

const LEGACY_OP_MAP: Record<string, string> = {
  sparc: "auto", // SPARC's job (plan + write) is what the router decides anyway
  tot: "branch-compare",
  blueprint: "scaffold",
  "swarm-review": "review",
};

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  // Burst guard: orchestrate fans out to multiple LLM calls per op.
  // Fail closed: a limiter failure must throttle, never open the floodgate.
  if (!(await checkBurstLimit(session.user.id).catch(() => false))) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again in about a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const body = await request.json().catch(() => ({}));
  const rawOp = String(body.op || "");
  const op = LEGACY_OP_MAP[rawOp] ?? rawOp;
  const task = clamp(body.task, MAX_TASK_CHARS);
  if (!op || !task) {
    return NextResponse.json({ ok: false, error: "op and task are required" }, { status: 400 });
  }
  const context = clamp(body.context, MAX_CONTEXT_CHARS);
  const model = typeof body.model === "string" ? body.model : null;

  try {
    switch (op) {
      case "auto":
      case "plan":
      case "implement":
      case "branch-compare":
      case "scaffold": {
        const result = await runStrategy(
          {
            task,
            context: context || undefined,
            existingFileCount: typeof body.existingFileCount === "number" ? body.existingFileCount : undefined,
            modelOverride: model,
          },
          op === "auto" ? undefined : (op as "plan" | "implement" | "branch-compare" | "scaffold"),
        );
        return NextResponse.json({
          ok: result.ok,
          strategy: result.strategy,
          status: result.ok ? "completed" : "failed", // legacy sparc consumers read `status`
          summary: result.summary,
          toolCalls: result.toolCalls,
          files: result.files,
          error: result.error,
        });
      }

      case "review": {
        const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
        if (files.length === 0) {
          return NextResponse.json({ ok: false, error: "files[] required for review" }, { status: 400 });
        }
        const out = await strategyReview(
          files.map((f: { path: string; content: string }) => ({ path: f.path, content: clamp(f.content, MAX_FILE_CHARS) })),
          task,
          model,
        );
        return NextResponse.json({
          ok: out.ok,
          consensus: out.consensus,
          review: JSON.stringify(out.findings ?? []), // legacy shape: review text
          findings: out.findings,
          tests: "",
          summary: out.summary,
          error: out.error,
        });
      }

      case "plan-legacy":
        // The old langchain "plan" op was removed long ago (its plans
        // referenced tools that never executed). Kept as an explicit 410 so
        // stale clients get a clear answer instead of a generic 400.
        return NextResponse.json(
          { ok: false, error: "op 'plan-legacy' removed — the strategy router's 'plan' op replaces it" },
          { status: 410 }
        );

      default:
        return NextResponse.json({ ok: false, error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
