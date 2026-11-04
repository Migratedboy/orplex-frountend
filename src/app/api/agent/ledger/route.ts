// API route for the persistent run ledger (task_runs / task_failures).
//
// This is the endpoint run-ledger.ts posts to at task finalize and reads from
// at task start. Before this route existed the client posted ledger payloads
// to /api/agent/history — the FILE UNDO route, which requires {path, next}
// and answered 400 to every ledger payload — so cross-restart failure
// learning has never worked and task_runs/task_failures had zero writers.
//
// The route is deliberately narrow: it authenticates, normalizes via the
// service module (src/lib/task-ledger.ts — the payload rules live there),
// and maps service errors to HTTP. Authentication mirrors exec/route.ts
// exactly: the worker runs in the browser, and an unauthenticated/absent
// caller must get a plain 401/404 the client degrades on — never a 500.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import {
  listOpenFailures,
  normalizeLedgerPayload,
  persistRunOutcome,
  workspaceKeyFrom,
} from "@/lib/task-ledger";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const normalized = normalizeLedgerPayload(body);
    if (!normalized) {
      return Response.json({ ok: false, error: "Invalid ledger payload" }, { status: 400 });
    }

    try {
      await persistRunOutcome(normalized);
    } catch (error) {
      // Generic 500: Prisma internals must not reach the client.
      console.error("[ledger POST]", error instanceof Error ? error.message : error);
      return Response.json({ ok: false, error: "Failed to record run" }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("[ledger POST]", error instanceof Error ? error.message : error);
    return Response.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

/**
 * GET /api/agent/ledger?workspaceKey=... — the open (unresolved) failure
 * signatures for one workspace, newest first. Shape is what
 * fetchLedgerFailures expects: { ok, failures: [{kind, detail, files, count, when}] }.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceKey = workspaceKeyFrom(request.nextUrl.searchParams.get("workspaceKey"));
    if (!workspaceKey) {
      return Response.json({ ok: false, error: "workspaceKey required" }, { status: 400 });
    }

    try {
      const failures = await listOpenFailures(workspaceKey);
      return Response.json({ ok: true, failures });
    } catch (error) {
      console.error("[ledger GET]", error instanceof Error ? error.message : error);
      return Response.json({ ok: false, error: "Ledger unavailable" }, { status: 500 });
    }
  } catch (error) {
    console.error("[ledger GET]", error instanceof Error ? error.message : error);
    return Response.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
