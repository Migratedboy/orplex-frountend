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
}

export type DevicePollStatus = "pending" | "slow_down" | "authorized" | "expired" | "denied" | "error";

export interface DevicePollResult {
  status: DevicePollStatus;
  login?: string | null;
  message?: string;
}

interface FlowState {
  deviceCode: string;
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
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Ask GitHub for a user code. */
export async function startDeviceFlow(userId: string): Promise<DeviceFlowStart | null> {
  const clientId = githubAppClientId();
  if (!clientId) return null;
  prune();
  const body = await postForm(DEVICE_CODE_URL, { client_id: clientId });
  // GitHub answers 200 with an `error` body for an app that has not enabled
  // device flow (`device_flow_disabled`) — surface its own words instead of
  // pretending the app is unconfigured, which reads as "nothing to see here".
  const ghError = typeof body.error === "string" ? body.error : "";
  if (ghError) {
    const detail = typeof body.error_description === "string" ? body.error_description : ghError;
    throw new Error(`GitHub refused the device code: ${detail}`);
  }
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  if (!deviceCode || !userCode) return null;
  const expiresIn = Number(body.expires_in) || 900;
  const interval = Math.max(1, Number(body.interval) || 5);
  const flowId = crypto.randomUUID();
  flows.set(flowId, {
    deviceCode,
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
  };
}

/** Poll GitHub once for a started flow; stores the token when it lands. */
export async function pollDeviceFlow(flowId: string, userId: string): Promise<DevicePollResult> {
  const clientId = githubAppClientId();
  if (!clientId) return { status: "error", message: "GitHub App is not configured" };
  const flow = flows.get(flowId);
  if (!flow || flow.userId !== userId) return { status: "expired" };
  if (flow.expiresAt < Date.now()) {
    flows.delete(flowId);
    return { status: "expired" };
  }
  if (flow.status === "authorized") return { status: "authorized", login: flow.login ?? null };

  try {
    const body = await postForm(ACCESS_TOKEN_URL, {
      client_id: clientId,
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
    const scope = typeof body.scope === "string" ? body.scope : "";
    const login = await fetchLogin(token);
    await saveAppToken(userId, token, scope, login);
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

/** Persist the device-flow token locally for this user. */
export async function saveAppToken(
  userId: string,
  token: string,
  scope: string,
  login: string | null
): Promise<void> {
  const providerAccountId = login || "default";
  await prisma.account.upsert({
    where: { provider_providerAccountId: { provider: GITHUB_APP_PROVIDER, providerAccountId } },
    update: { userId, access_token: token, scope, token_type: "bearer" },
    create: {
      userId,
      type: "oauth",
      provider: GITHUB_APP_PROVIDER,
      providerAccountId,
      access_token: token,
      scope,
      token_type: "bearer",
    },
  });
}

/**
 * The credential to use for repository work: a GitHub App token (device flow)
 * wins over an OAuth App token, because the App token is what the user just
 * approved and carries the narrower scope.
 */
export async function readGithubToken(
  userId: string
): Promise<{ token: string; scope: string | null; source: "github-app" | "oauth" } | null> {
  const app = await prisma.account.findFirst({
    where: { userId, provider: GITHUB_APP_PROVIDER },
    select: { access_token: true, scope: true },
  });
  if (app?.access_token) return { token: app.access_token, scope: app.scope, source: "github-app" };

  const oauth = await prisma.account.findFirst({
    where: { userId, provider: "github" },
    select: { access_token: true, scope: true },
  });
  if (oauth?.access_token) return { token: oauth.access_token, scope: oauth.scope, source: "oauth" };
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
