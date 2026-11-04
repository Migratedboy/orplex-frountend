/**
 * task-ledger.ts — business core of /api/agent/ledger (task_runs / task_failures).
 *
 * The route is deliberately a thin coordinator: it authenticates and maps
 * errors to HTTP; everything that defines what a ledger payload IS lives
 * here so it is testable without HTTP and the client contract (flat or
 * `run`-nested payload shapes) has exactly one implementation.
 *
 * Fail-closed normalization: every field is coerced to a known value or the
 * payload is rejected — a bad payload never writes.
 */
import { createHash } from "node:crypto";
import type { PrismaPromise } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Failure kinds — matches FailureKind in failure-memory.ts and TaskFailure.kind. */
const FAILURE_KINDS = ["typecheck", "browser", "command", "review"] as const;
type FailureKind = (typeof FAILURE_KINDS)[number];

const FINAL_STATUSES = ["done", "error", "aborted"] as const;
const LANE_VERDICTS = ["pass", "fail", "skipped"] as const;
type LaneVerdict = (typeof LANE_VERDICTS)[number];

const MAX_TASK_CHARS = 4_000;
const MAX_MODE_CHARS = 40;
const MAX_WORKSPACE_KEY_CHARS = 200;
const MAX_DETAIL_CHARS = 600;
const MAX_FILES = 5;
const MAX_FILE_CHARS = 300;
const MAX_FAILURES = 20;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface NormalizedRun {
  workspaceKey: string;
  task: string;
  mode: string;
  finalStatus: "done" | "error" | "aborted";
  lanes: { typecheck: LaneVerdict; browser: LaneVerdict; swarm: LaneVerdict };
  durationMs: number;
  modelCalls: number;
  fullCalls: number;
  compactCalls: number;
  systemTokensSpent: number;
  systemTokensFull: number;
  tokensSaved: number;
  savedPct: number;
}

export interface NormalizedFailure {
  kind: FailureKind;
  detail: string;
  files: string[];
  count: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNonEmptyString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asCount(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.min(Math.max(n, 0), 1_000_000_000);
}

function asLaneVerdict(v: unknown): LaneVerdict {
  return (LANE_VERDICTS as readonly string[]).includes(String(v))
    ? (v as LaneVerdict)
    : "skipped";
}

/**
 * Accept both shapes the client can send: the flat shape the route contract
 * names ({ workspaceKey, task, mode, finalStatus, lanes, durationMs }) and
 * the nested shape buildFinalizePayload actually produces (those fields under
 * `run`, plus economics, `failures`, `passedLanes`). Returns null when the
 * payload is not a ledger payload at all.
 */
export function normalizeLedgerPayload(
  body: unknown
): { run: NormalizedRun; failures: NormalizedFailure[]; resolveKinds: FailureKind[] } | null {
  if (!isRecord(body)) return null;
  const run = isRecord(body.run) ? body.run : body;

  const workspaceKey = asNonEmptyString(body.workspaceKey ?? run.workspaceKey, MAX_WORKSPACE_KEY_CHARS);
  const task = typeof (run.task ?? body.task) === "string" ? String(run.task ?? body.task).slice(0, MAX_TASK_CHARS) : null;
  const finalStatusRaw = String(run.finalStatus ?? body.finalStatus ?? "");
  if (!workspaceKey || task === null) return null;
  if (!(FINAL_STATUSES as readonly string[]).includes(finalStatusRaw)) return null;

  const lanesRaw = isRecord(run.lanes) ? run.lanes : isRecord(body.lanes) ? body.lanes : null;
  if (!lanesRaw) return null;

  const durationRaw = run.durationMs ?? body.durationMs;
  const durationMs = Math.min(
    MAX_DURATION_MS,
    typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0 ? Math.floor(durationRaw) : 0
  );

  const failures: NormalizedFailure[] = [];
  const rawFailures = Array.isArray(body.failures) ? body.failures : [];
  for (const f of rawFailures.slice(0, MAX_FAILURES)) {
    if (!isRecord(f)) continue;
    const kind = f.kind;
    if (!(FAILURE_KINDS as readonly string[]).includes(String(kind))) continue;
    const detail = typeof f.detail === "string" ? f.detail.trim().slice(0, MAX_DETAIL_CHARS) : "";
    if (!detail) continue;
    const files = (Array.isArray(f.files) ? f.files : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.slice(0, MAX_FILE_CHARS))
      .slice(0, MAX_FILES);
    const count = Math.min(Math.max(asCount(f.count) || 1, 1), 1_000);
    failures.push({ kind: kind as FailureKind, detail, files, count });
  }

  // Lane key → failure kind (swarm/review are recorded under "review"; a
  // passing lane resolves its open signatures so stale wounds stop teaching).
  const LANE_TO_KIND: Record<string, FailureKind> = {
    typecheck: "typecheck",
    browser: "browser",
    swarm: "review",
  };
  const passedLanes = Array.isArray(body.passedLanes) ? body.passedLanes : [];
  const resolveKinds = [...new Set(
    passedLanes
      .map((l) => LANE_TO_KIND[String(l)])
      .filter((k): k is FailureKind => !!k)
  )];

  return {
    run: {
      workspaceKey,
      task,
      mode: asNonEmptyString(run.mode ?? body.mode, MAX_MODE_CHARS) ?? "code",
      finalStatus: finalStatusRaw as "done" | "error" | "aborted",
      lanes: {
        typecheck: asLaneVerdict(lanesRaw.typecheck),
        browser: asLaneVerdict(lanesRaw.browser),
        swarm: asLaneVerdict(lanesRaw.swarm),
      },
      durationMs,
      modelCalls: asCount(run.modelCalls),
      fullCalls: asCount(run.fullCalls),
      compactCalls: asCount(run.compactCalls),
      systemTokensSpent: asCount(run.systemTokensSpent),
      systemTokensFull: asCount(run.systemTokensFull),
      tokensSaved: asCount(run.tokensSaved),
      savedPct: Math.min(asCount(run.savedPct), 1000),
    },
    failures,
    resolveKinds,
  };
}

/** Stable identity of `detail` — the same unique key TaskFailure declares. */
function detailHash(detail: string): string {
  return createHash("sha256").update(detail).digest("hex").slice(0, 32);
}

/**
 * Persist one TaskRun plus this run's failure evidence in one transaction:
 * recurrence raises `count` (the anti-loop signal), a passing lane resolves
 * its open signatures so the next hydrate does not keep teaching a wound
 * that is already healed.
 */
export async function persistRunOutcome(outcome: {
  run: NormalizedRun;
  failures: NormalizedFailure[];
  resolveKinds: string[];
}): Promise<void> {
  const { run, failures, resolveKinds } = outcome;
  const ops: Array<PrismaPromise<unknown>> = [
    prisma.taskRun.create({
      data: {
        workspaceKey: run.workspaceKey,
        task: run.task,
        mode: run.mode,
        finalStatus: run.finalStatus,
        typecheckLane: run.lanes.typecheck,
        browserLane: run.lanes.browser,
        swarmLane: run.lanes.swarm,
        modelCalls: run.modelCalls,
        fullCalls: run.fullCalls,
        compactCalls: run.compactCalls,
        systemTokensSpent: run.systemTokensSpent,
        systemTokensFull: run.systemTokensFull,
        tokensSaved: run.tokensSaved,
        savedPct: run.savedPct,
        durationMs: run.durationMs,
      },
    }),
  ];

  for (const f of failures) {
    ops.push(
      prisma.taskFailure.upsert({
        where: {
          workspaceKey_kind_detailHash: {
            workspaceKey: run.workspaceKey,
            kind: f.kind,
            detailHash: detailHash(f.detail),
          },
        },
        update: { count: { increment: f.count }, lastSeenAt: new Date() },
        create: {
          workspaceKey: run.workspaceKey,
          kind: f.kind,
          detail: f.detail,
          detailHash: detailHash(f.detail),
          files: f.files,
          count: f.count,
        },
      })
    );
  }

  if (resolveKinds.length > 0) {
    ops.push(
      prisma.taskFailure.updateMany({
        where: {
          workspaceKey: run.workspaceKey,
          kind: { in: resolveKinds as FailureKind[] },
          resolvedAt: null,
        },
        data: { resolvedAt: new Date() },
      })
    );
  }

  await prisma.$transaction(ops);
}

/** Coerce a caller-supplied workspace key with the same fail-closed rules. */
export function workspaceKeyFrom(value: unknown): string | null {
  return asNonEmptyString(value, MAX_WORKSPACE_KEY_CHARS);
}

export interface LedgerFailureRow {
  kind: string;
  detail: string;
  files: string[];
  count: number;
  when: number;
}

/**
 * The open (unresolved) failure signatures for one workspace, newest first.
 * Shape is what fetchLedgerFailures expects.
 */
export async function listOpenFailures(workspaceKey: string): Promise<LedgerFailureRow[]> {
  const rows = await prisma.taskFailure.findMany({
    where: { workspaceKey, resolvedAt: null },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
  return rows.map((f) => ({
    kind: f.kind,
    detail: f.detail,
    files: Array.isArray(f.files) ? (f.files as unknown[]).filter((x): x is string => typeof x === "string") : [],
    count: Number(f.count) || 1,
    when: f.lastSeenAt instanceof Date ? f.lastSeenAt.getTime() : Date.now(),
  }));
}
