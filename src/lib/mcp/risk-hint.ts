// Shim — this module now lives in @orplex/sdk.
//
// The app keeps importing "@/lib/mcp/risk-hint" unchanged, so the extraction is
// reversible per module: delete this file and restore it from git to roll back.
// Implementations, fixes and tests for it belong in the SDK repo.
export * from "@orplex/sdk/lib/mcp/risk-hint";
