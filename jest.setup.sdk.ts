// jest.setup.sdk.ts — runs before any test module is imported.
//
// Three things the app declares at boot, which tests need too:
//
// 1. Approvals. The SDK store fails closed: with no host policy it refuses
//    medium/high-risk tool calls instead of parking them. That default is right
//    for a headless library, but the app IS a host — it answers approvals by
//    polling getPendingApprovals() — so tests get the same "poll" contract.
// 2. The MCP catalogue. Skills, servers and bundles are marketplace data now.
//    In production they arrive over the network at boot; in tests there is no
//    network, so a checked-in fixture (a slice of the published catalogue) is
//    installed. __setMcpCatalogForTests() lets a suite use its own instead.
// 3. The plugin library. The SDK's hook gate asks the host for bundles through
//    configureLibraryBundles(); the app registers the marketplace provider, so
//    tests register the fixture. Without it no library rules ever reach a gate.
import path from "node:path";
import os from "node:os";
import { configureApprovals } from "@orplex/sdk";

// 0. Workspace registry file. workspace-cwd.ts keeps a durable device-local map
//    there and treats it as the shared truth across route chunks; tests must not
//    read or write the developer's real registrations (they did, and left junk
//    rows behind).
process.env.ORPLEX_WORKSPACES_FILE = path.join(os.tmpdir(), `orplex-jest-workspaces-${process.pid}.json`);
import { configureLibraryBundles } from "@orplex/sdk/lib/plugin-library-state";
import { materializeBundles } from "@orplex/sdk/lib/plugin-library";
import { __setMcpCatalogForTests } from "./src/lib/marketplace-client";

configureApprovals({ mode: "poll" });

try {
  const catalog = require("./src/lib/__tests__/fixtures/mcp-catalog.json") as {
    entries: import("@orplex/sdk/mcp").McpCatalogEntry[];
  };
  __setMcpCatalogForTests(catalog.entries);

  const bundles = require("./src/lib/__tests__/fixtures/plugin-bundles.json") as {
    bundles: import("@orplex/sdk/lib/plugin-library/types").BundleDef[];
  };
  const materialized = materializeBundles(bundles.bundles);
  configureLibraryBundles(() => materialized);
} catch (e) {
  // A missing fixture must not silently pass tests that need a catalogue — it
  // just leaves them empty, and those tests fail loudly with their own message.
  console.warn("jest.setup.sdk: catalogue fixtures not loaded:", e);
}
