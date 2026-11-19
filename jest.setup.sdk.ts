// jest.setup.sdk.ts — runs before any test module is imported.
//
// The SDK's approval store fails closed: with no host policy it refuses
// medium/high-risk tool calls instead of parking them. That default is right
// for a headless library, but the app under test IS a host — it answers
// approvals by polling getPendingApprovals() — so tests that auto-approve need
// the same contract the app declares at boot.
import { configureApprovals } from "@orplex/sdk";

configureApprovals({ mode: "poll" });
