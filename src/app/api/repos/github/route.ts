import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { backendJson } from "@/lib/backend-client";
import { appSessionUserFromRequest } from "@/lib/app-session";
import { clearAppToken, readGithubToken } from "@/lib/github-app";

export const dynamic = "force-dynamic";

/**
 * GET /api/repos/github — repositories the signed-in user can clone.
 *
 * Two sources, in order:
 *   1. A GitHub token stored LOCALLY (dev sign-in, or an install that completed
 *      the OAuth round-trip against this machine).
 *   2. The cloud backend, which is where the desktop sign-in actually stores the
 *      token (see the exchange route: the app only ever receives a signed
 *      session, never provider tokens). Its /api/repos/github accepts our
 *      orplex-app-session cookie.
 *
 * Without step 2 this endpoint answered "not connected" for every real user,
 * which is exactly the empty picker this feature is meant to replace.
 */

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_REPOS = 300;

export interface GitHubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
  cloneUrl: string;
}

export function toSummary(raw: Record<string, unknown>): GitHubRepoSummary | null {
  const fullName = typeof raw.full_name === "string" ? raw.full_name : "";
  const owner = (raw.owner as { login?: unknown } | undefined)?.login;
  if (!fullName || typeof owner !== "string") return null;
  const name = typeof raw.name === "string" ? raw.name : fullName.split("/")[1];
  if (!name) return null;
  return {
    fullName,
    owner,
    name,
    private: raw.private === true,
    defaultBranch: typeof raw.default_branch === "string" ? raw.default_branch : "main",
    description: typeof raw.description === "string" ? raw.description : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
    cloneUrl: typeof raw.clone_url === "string" ? raw.clone_url : `https://github.com/${fullName}.git`,
  };
}

/** True when the granted OAuth scopes allow reading private repositories. */
export function scopeHasRepo(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope.split(/[,\s]+/).some((s) => s === "repo" || s === "public_repo");
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orplex-code",
  };
}

/**
 * The signed-in user, from either door: the app's local next-auth session (dev
 * and browser previews) or the backend-issued Ed25519 app session that the
 * packaged app actually carries. The local server cannot verify the latter with
 * NEXTAUTH_SECRET — that is the whole reason the Ed25519 cookie exists.
 */
async function resolveUserId(request: NextRequest): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (session?.user?.id) return session.user.id;
  const appUser = await appSessionUserFromRequest(request);
  return appUser?.id ?? null;
}

/** List repos with a locally stored token. */
async function listWithLocalToken(
  token: string
): Promise<{ repos: GitHubRepoSummary[]; error?: string; status?: number }> {
  const repos: GitHubRepoSummary[] = [];
  const seen = new Set<string>();
  const url =
    `${GITHUB_API}/user/repos?per_page=${PER_PAGE}&sort=updated&direction=desc` +
    `&affiliation=owner,collaborator,organization_member&visibility=all`;
  let next: string | null = url;
  try {
    while (next && repos.length < MAX_REPOS) {
      const res: Response = await fetch(next, {
        headers: ghHeaders(token),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 || res.status === 429) {
        return { repos, error: "GitHub rate limit reached — try again in a minute, or clone by URL.", status: res.status };
      }
      if (!res.ok) {
        return { repos, error: `GitHub responded ${res.status}.`, status: res.status };
      }
      const page = (await res.json().catch(() => [])) as unknown;
      if (!Array.isArray(page)) break;
      for (const raw of page) {
        const summary = toSummary(raw as Record<string, unknown>);
        if (summary && !seen.has(summary.fullName)) {
          seen.add(summary.fullName);
          repos.push(summary);
        }
        if (repos.length >= MAX_REPOS) break;
      }
      const link = res.headers.get("link") ?? "";
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      next = match ? match[1] : null;
    }
    return { repos };
  } catch {
    return { repos, error: "Could not reach GitHub." };
  }
}

export async function GET(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const credential = await readGithubToken(userId);

  if (credential) {
    const { repos, error, status } = await listWithLocalToken(credential.token);
    // A token GitHub refuses is not an empty account: say so, and offer a
    // reconnect instead of rendering a list that looks complete.
    if (status === 401) {
      // A dead device-flow token is worth dropping so the next connect starts
      // clean; an OAuth token belongs to the backend and is left alone.
      if (credential.source === "github-app") await clearAppToken(userId);
      return NextResponse.json({
        success: true,
        connected: false,
        login: null,
        needsScope: true,
        repos: [],
        source: credential.source,
        error: "GitHub no longer accepts this token. Connect GitHub again.",
      });
    }
    let login: string | null = null;
    try {
      const me = await fetch(`${GITHUB_API}/user`, {
        headers: ghHeaders(credential.token),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (me.ok) {
        const body = (await me.json()) as { login?: unknown };
        if (typeof body?.login === "string") login = body.login;
      }
    } catch {
      /* display name only */
    }
    return NextResponse.json({
      success: true,
      connected: true,
      login,
      needsScope: !scopeHasRepo(credential.scope),
      repos,
      source: credential.source,
      ...(error ? { error } : {}),
    });
  }

  // No local token: ask the backend that ran the OAuth round-trip.
  const remote = await backendJson<{
    connected?: boolean;
    login?: string | null;
    needsScope?: boolean;
    repos?: GitHubRepoSummary[];
    error?: string;
  }>("/api/repos/github", { cookieHeader: request.headers.get("cookie") });

  if (remote && remote.data) {
    return NextResponse.json({
      success: true,
      connected: remote.data.connected === true,
      login: remote.data.login ?? null,
      needsScope: remote.data.needsScope === true,
      repos: Array.isArray(remote.data.repos) ? remote.data.repos : [],
      source: "backend",
      ...(remote.data.error ? { error: remote.data.error } : {}),
    });
  }

  return NextResponse.json({
    success: true,
    connected: false,
    login: null,
    needsScope: false,
    repos: [],
    source: remote ? "backend" : "none",
    ...(remote ? { error: "The Orplex backend could not be reached." } : { error: "No cloud account is linked to this install." }),
  });
}

/**
 * POST /api/repos/clone-token { fullName } — a credential for one private repo.
 *
 * The clone itself happens locally (git + path jail), so the backend hands out
 * a token for a repo it has verified the user can read. Deliberately not
 * persisted anywhere: it lives for the duration of the clone.
 */
export async function POST(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    return NextResponse.json({ success: false, error: "Invalid repository name" }, { status: 400 });
  }

  const local = await readGithubToken(userId);
  if (local) {
    return NextResponse.json({ success: true, token: local.token, source: local.source });
  }

  const remote = await backendJson<{ token?: string; cloneUrl?: string; error?: string }>(
    "/api/repos/github",
    { method: "POST", body: { fullName }, cookieHeader: request.headers.get("cookie") }
  );
  if (!remote || !remote.ok || !remote.data?.token) {
    return NextResponse.json(
      { success: false, error: remote?.data?.error || "No GitHub credential available" },
      { status: remote?.status && remote.status >= 400 ? remote.status : 400 }
    );
  }
  return NextResponse.json({ success: true, token: remote.data.token, source: "backend" });
}
