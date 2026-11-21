// sdk-host.ts — where the app declares the two things the SDK cannot know
// about its host. Import this before any tool call can be dispatched.
//
// 1. Approvals. The SDK store fails closed by default: with no host policy it
//    refuses medium/high-risk tool calls immediately. This app IS such a host —
//    it renders dialogs from the pending list and answers them over
//    /api/agent/approvals — so it declares "poll" mode and the SDK parks the
//    call on a promise until that route answers.
// 2. Marketplace. The catalog is verified Ed25519-signed data; the public key
//    ships with the app so a compromised CDN cannot inject skills or MCP specs.
//
// Narrow subpaths on purpose: background-worker is reachable from a client
// component (useChatSession), so importing the SDK umbrella here would drag
// fs/child_process modules into the browser bundle.
import { configureApprovals } from "@orplex/sdk/lib/approval-store";
import { configureAgentRuntime } from "@orplex/sdk/lib/runtime-config";

let configured = false;

/** Idempotent: safe to import from several entry points (routes, worker, tests). */
export function configureSdkHost(): void {
  if (configured) return;
  configured = true;

  configureApprovals({ mode: "poll" });

  // Dynamic tool routing: a user with several connectors easily reaches 200 MCP
  // tools, and every schema costs prompt budget. Route the roster against the
  // current turn, keep 15 schemas live, and leave the rest reachable through
  // mcp_search_tools / mcp_describe_tool. Pinned tools are never routed away —
  // ORPLEX_PINNED_TOOLS lets a power user hold a few permanently.
  const pinned = (process.env.ORPLEX_PINNED_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  configureAgentRuntime({ enableDynamicToolRouting: true, maxActiveTools: 15, pinnedTools: pinned });

  // Library bundles are NOT registered here: materializing them pulls filesystem
  // code and this module is client-reachable. marketplace-bundles.ts (server
  // only) registers the provider when a server entry point imports it.

  // The app version gates marketplace items (each item declares a minimum app
  // version) — expose it so plugin/skill resolution can honour that.
  const appVersion = process.env.npm_package_version;
  if (appVersion) process.env.ORPLEX_APP_VERSION = appVersion;
}

configureSdkHost();
