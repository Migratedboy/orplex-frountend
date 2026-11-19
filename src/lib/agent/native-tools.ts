// Shim — this module now lives in @orplex/sdk.
//
// The app keeps importing "@/lib/agent/native-tools" unchanged, so the extraction is
// reversible per module: delete this file and restore it from git to roll back.
// Implementations, fixes and tests for it belong in the SDK repo.
export * from "@orplex/sdk/lib/agent/native-tools";
