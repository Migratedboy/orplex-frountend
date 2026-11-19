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
// Narrow subpath on purpose: background-worker is reachable from a client
// component (useChatSession), so importing the SDK umbrella here would drag
// fs/child_process modules into the browser bundle.
import { configureApprovals } from "@orplex/sdk/lib/approval-store";

let configured = false;

/** Idempotent: safe to import from several entry points (routes, worker, tests). */
export function configureSdkHost(): void {
  if (configured) return;
  configured = true;

  configureApprovals({ mode: "poll" });

  // The app version gates marketplace items (each item declares a minimum app
  // version) — expose it so plugin/skill resolution can honour that.
  const appVersion = process.env.npm_package_version;
  if (appVersion) process.env.ORPLEX_APP_VERSION = appVersion;
}

configureSdkHost();
