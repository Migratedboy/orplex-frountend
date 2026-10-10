// compaction-memory.ts — SHIM (folded into workspace-memory.ts).
//
// There is no separate compaction store: eviction capture lives in the
// workspace-learnings bucket (extractEvictionFacts + captureFromCompaction in
// workspace-memory.ts). This module re-exports that pair so existing callers
// (server-executor, tests) keep working unchanged. New code imports from
// workspace-memory directly. Scheduled for deletion once callers migrate.

export { extractEvictionFacts, captureFromCompaction } from "./workspace-memory";
