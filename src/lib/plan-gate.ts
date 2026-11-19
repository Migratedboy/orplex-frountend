// Shim — this module now lives in @orplex/sdk.
//
// The app keeps importing "@/lib/plan-gate" unchanged, so the extraction is
// reversible per module: delete this file and restore it from git to roll back.
// Implementations, fixes and tests for it belong in the SDK repo.
export * from "@orplex/sdk/lib/plan-gate";
