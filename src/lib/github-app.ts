// github-app.ts — GitHub App authentication via the DEVICE FLOW.
//
// Why this exists next to the OAuth App: the desktop's OAuth round-trip has to
// bounce through the mediator site and back to a loopback origin, and every hop
// (return_to, grant, cookie domain) is a place for sign-in to quietly fail. A
// GitHub App with device flow has NO redirect URI and NO cookies: the app asks
// GitHub for a short code, the user types it on github.com/login/device, and we
// poll for the token. That is the flow native desktop clients use, it works
// behind any firewall, and the token is scoped to what the user approved.
//
// Registration (one-time, on github.com — cannot be automated here):
//   Settings → Developer settings → GitHub Apps → New GitHub App
//     • "Enable Device Flow"                     ✓  (required; nothing works without it)
//     • Repository permissions → Contents: Read  (clone/pull)
//     • User permissions → none needed
//   Then set GITHUB_APP_CLIENT_ID (public, safe to ship) and optionally
//   GITHUB_APP_SLUG (for the install link) in the app's env.
//
// A user-to-server token (`ghu_…`) from this flow can list repositories the user
// granted and clone them: https://x-access-token:<token>@github.com/owner/repo.
// The token is stored in the LOCAL Prisma Account row (provider "github-app") —
// the user's own machine, never the cloud.

import { prisma } from "@/lib/prisma";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const VERIFICATION_URI = "https://github.com/login/device";

/** Provider key used for device-flow tokens in the Account table. */
export const GITHUB_APP_PROVIDER = "github-app";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_FLOWS = 200;

export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  source: "oauth" | "app";
}

export type DevicePollStatus = "pending" | "slow_down" | "authorized" | "expired" | "denied" | "error";

export interface DevicePollResult {
  status: DevicePollStatus;
  login?: string | null;
  message?: string;
}

interface FlowState {
  deviceCode: string;
  clientId: string;
  scope: string;
  kind: "oauth" | "app";
  interval: number;
  expiresAt: number;
  userId: string;
  status: DevicePollStatus;
  login?: string | null;
  message?: string;
}

// Deliberately in-memory: a device flow lives for minutes, belongs to one
// process, and holds a half-finished credential. Losing it on restart costs one
// retry — persisting it would put a pending auth code in a database for no gain.
const flows = new Map<string, FlowState>();

export function githubAppClientId(): string | null {
  // GITHUB_APP_CLIENT_ID is read on the server; the NEXT_PUBLIC_ variant is
  // inlined at build time so a packaged app can ship it without an env file.
  // A client id is public by design (it is not a secret), unlike the OAuth
  // app's client secret — device flow never uses one.
  const raw = (process.env.GITHUB_APP_CLIENT_ID || process.env.NEXT_PUBLIC_GITHUB_APP_CLIENT_ID || "").trim();
  return raw && !raw.includes("your_") ? raw : null;
}

/** Scopes the device flow asks for when the credential comes from an OAuth App. */
export const DEVICE_SCOPE = "repo read:user user:email";

export interface DeviceClient {
  clientId: string;
  scope: string;
  /** oauth → token behaves like a normal OAuth token (no install needed). */
  kind: "oauth" | "app";
}

/**
 * Which app the device flow should talk to.
 *
 * The GitHub App is tried FIRST: its token is what the app's own repo plumbing
 * is built around (installation-scoped Contents access), and its permissions
 * live on the App, so the consent screen asks exactly for what the App holds.
 *
 * The OAuth App is the fallback: an OAuth token needs no installation at all,
 * so if the App has device flow switched off (a one-checkbox condition on
 * GitHub's side that must not turn into a dead button) the user still gets a
 * code instead of an error. Tokens are stored per kind — App under
 * "github-app", OAuth under "github" — so the install prompt can never fire for
 * an OAuth token.
 *
 * NOTE on the consent screen: the "Read-only access to Email addresses" line is
 * a PERMISSION of the GitHub App (Email addresses: Read-only), not something
 * this code requests. It disappears only when that permission is unchecked in
 * the App's settings on GitHub (Settings → Developer settings → GitHub Apps →
 * this app → Permissions & events).
 */
export function deviceClients(): DeviceClient[] {
  const out: DeviceClient[] = [];
  const app = githubAppClientId();
  if (app) out.push({ clientId: app, scope: "", kind: "app" });
  const oauth = (process.env.GITHUB_DEVICE_CLIENT_ID || "").trim();
  if (oauth && !oauth.includes("your_") && !out.some((c) => c.clientId === oauth)) {
    out.push({ clientId: oauth, scope: DEVICE_SCOPE, kind: "oauth" });
  }
  return out;
}

export function githubAppSlug(): string | null {
  const raw = (process.env.GITHUB_APP_SLUG || "").trim();
  return raw || null;
}

function prune(now = Date.now()): void {
  for (const [id, flow] of flows) {
    if (flow.expiresAt < now) flows.delete(id);
  }
  // Hard cap: a caller cannot grow this map without bound.
  if (flows.size > MAX_FLOWS) {
    const oldest = [...flows.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of oldest.slice(0, flows.size - MAX_FLOWS)) flows.delete(id);
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // GitHub answers 400/401 WITH a JSON explanation (`device_flow_disabled`,
  // `incorrect_client_credentials`). Throwing the bare status turned that into
  // "GitHub responded 400" and threw away the only part the user can act on.
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail =
      (typeof parsed.error_description === "string" && parsed.error_description) ||
      (typeof parsed.error === "string" && parsed.error) ||
      "";
    throw new Error(detail ? `GitHub refused the request: ${detail}` : `GitHub responded ${res.status}`);
  }
  return parsed;
}

/** Ask GitHub for a user code, trying each configured app in turn. */
export async function startDeviceFlow(userId: string): Promise<DeviceFlowStart | null> {
  const clients = deviceClients();
  if (clients.length === 0) return null;
  prune();

  let lastError: Error | null = null;
  for (const client of clients) {
    let body: Record<string, unknown>;
    try {
      body = await postForm(DEVICE_CODE_URL, {
        client_id: client.clientId,
        ...(client.scope ? { scope: client.scope } : {}),
      });
    } catch (e) {
      // postForm throws on a non-2xx (GitHub uses 400 for "device flow off").
      // One disabled app must not abort the others — that is the whole reason
      // there is an ordered candidate list.
      lastError = e instanceof Error ? e : new Error("GitHub refused the device code");
      continue;
    }
    // GitHub answers 200 with an `error` body for an app that has not enabled
    // device flow (`device_flow_disabled`) — surface its own words instead of
    // pretending the app is unconfigured, which reads as "nothing to see here".
    // A 400 from one app is not fatal: the next candidate may be enabled.
    const ghError = typeof body.error === "string" ? body.error : "";
    if (ghError) {
      const detail = typeof body.error_description === "string" ? body.error_description : ghError;
      lastError = new Error(`GitHub refused the device code: ${detail}`);
      continue;
    }
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const userCode = typeof body.user_code === "string" ? body.user_code : "";
    if (!deviceCode || !userCode) continue;
    const expiresIn = Number(body.expires_in) || 900;
    const interval = Math.max(1, Number(body.interval) || 5);
    const flowId = crypto.randomUUID();
    flows.set(flowId, {
      deviceCode,
      clientId: client.clientId,
      scope: client.scope,
      kind: client.kind,
      interval,
      expiresAt: Date.now() + expiresIn * 1000,
      userId,
      status: "pending",
    });
    return {
      flowId,
      userCode,
      verificationUri: typeof body.verification_uri === "string" ? body.verification_uri : VERIFICATION_URI,
      expiresIn,
      interval,
      source: client.kind,
    };
  }
  if (lastError) throw lastError;
  return null;
}

/** Poll GitHub once for a started flow; stores the token when it lands. */
export async function pollDeviceFlow(flowId: string, userId: string): Promise<DevicePollResult> {
  const flow = flows.get(flowId);
  if (!flow || flow.userId !== userId) return { status: "expired" };
  if (flow.expiresAt < Date.now()) {
    flows.delete(flowId);
    return { status: "expired" };
  }
  if (flow.status === "authorized") return { status: "authorized", login: flow.login ?? null };

  try {
    const body = await postForm(ACCESS_TOKEN_URL, {
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const error = typeof body.error === "string" ? body.error : "";

    if (error === "authorization_pending") return { status: "pending" };
    if (error === "slow_down") {
      flow.interval += 5;
      return { status: "slow_down" };
    }
    if (error === "expired_token") {
      flows.delete(flowId);
      return { status: "expired" };
    }
    if (error === "access_denied") {
      flows.delete(flowId);
      return { status: "denied" };
    }
    if (error) return { status: "error", message: error };

    const token = typeof body.access_token === "string" ? body.access_token : "";
    if (!token) return { status: "error", message: "GitHub returned no token" };
    const scope = typeof body.scope === "string" ? body.scope : flow.scope;
    const login = await fetchLogin(token);
    await saveAppToken(userId, token, scope, login, flow.kind);
    flow.status = "authorized";
    flow.login = login;
    flows.set(flowId, flow);
    return { status: "authorized", login };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "GitHub request failed" };
  }
}

async function fetchLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "orplex-code",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: unknown };
    return typeof body?.login === "string" ? body.login : null;
  } catch {
    return null;
  }
}

/**
 * Persist a device-flow token locally for this user.
 *
 * An OAuth-App token is stored under provider "github" because it behaves like
 * any other OAuth token: `repo` reaches every repository, no installation. A
 * GitHub App token stays under "github-app" so the repository list knows an
 * empty result may mean "not installed yet" rather than "no repos".
 */
export async function saveAppToken(
  userId: string,
  token: string,
  scope: string,
  login: string | null,
  kind: "oauth" | "app" = "app"
): Promise<void> {
  const provider = kind === "oauth" ? "github" : GITHUB_APP_PROVIDER;
  const providerAccountId = login || "default";
  await prisma.account.upsert({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    update: { userId, access_token: token, scope, token_type: "bearer" },
    create: {
      userId,
      type: "oauth",
      provider,
      providerAccountId,
      access_token: token,
      scope,
      token_type: "bearer",
    },
  });
}

/**
 * The credential to use for repository work.
 *
 * An OAuth-App token comes first: `repo` reaches every repository the user can
 * see and needs no installation, which is what makes "Pull from GitHub" a
 * one-step flow. A GitHub App token is the fallback — narrower, but it exists
 * when the OAuth app has device flow switched off.
 */
export async function readGithubToken(
  userId: string
): Promise<{ token: string; scope: string | null; source: "github-app" | "oauth" } | null> {
  const oauth = await prisma.account.findFirst({
    where: { userId, provider: "github" },
    select: { access_token: true, scope: true },
  });
  if (oauth?.access_token) return { token: oauth.access_token, scope: oauth.scope, source: "oauth" };

  const app = await prisma.account.findFirst({
    where: { userId, provider: GITHUB_APP_PROVIDER },
    select: { access_token: true, scope: true },
  });
  if (app?.access_token) return { token: app.access_token, scope: app.scope, source: "github-app" };
  return null;
}

/** Drop the stored device-flow token (used when GitHub rejects it). */
export async function clearAppToken(userId: string): Promise<void> {
  try {
    await prisma.account.deleteMany({ where: { userId, provider: GITHUB_APP_PROVIDER } });
  } catch {
    /* best-effort */
  }
}
