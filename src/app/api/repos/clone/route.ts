import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { execFileSync } from "child_process";
import { mkdir, rm } from "fs/promises";
import { join, resolve, sep } from "path";
import { randomBytes } from "crypto";
import { backendJson } from "@/lib/backend-client";
import { readGithubToken } from "@/lib/github-app";

export const dynamic = "force-dynamic";

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const SCP_URL_RE = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

function parseRepo(url: string): { owner: string; name: string } | null {
  let m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], name: m[2] };
  m = url.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (m) return { owner: m[1], name: m[2] };
  return null;
}

function safeDestName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
  if (!url || (!GITHUB_URL_RE.test(url) && !SCP_URL_RE.test(url))) {
    return NextResponse.json({ success: false, error: "Invalid GitHub repository URL" }, { status: 400 });
  }
  const repo = parseRepo(url);
  if (!repo) {
    return NextResponse.json({ success: false, error: "Could not parse repository" }, { status: 400 });
  }

  // Resolve a GitHub credential for private repos: the device-flow / OAuth token
  // stored on this machine, else a per-repo credential from the backend. There
  // is deliberately no client-supplied token — the picker only offers real
  // repositories, and accepting a PAT over the wire would be a second, unaudited
  // way in.
  let token: string | null = null;
  const credential = await readGithubToken(session.user.id);
  if (credential) token = credential.token;

  // Still no credential: the desktop sign-in stores provider tokens on the
  // cloud backend, so ask it for one for THIS repo (verified server-side).
  // Needed for private repositories — cloning them is what the picker offers.
  // Never written to disk; it lives only for the clone below.
  if (!token) {
    const remote = await backendJson<{ token?: string }>("/api/repos/github", {
      method: "POST",
      body: { fullName: `${repo.owner}/${repo.name}` },
      cookieHeader: request.headers.get("cookie"),
    });
    if (remote?.ok && typeof remote.data?.token === "string" && remote.data.token) {
      token = remote.data.token;
    }
  }

  const baseDir = process.env.ORPLEX_REPOS_DIR || join(process.cwd(), ".orplex-repos");
  await mkdir(baseDir, { recursive: true });
  const destName = `${safeDestName(repo.owner)}-${safeDestName(repo.name)}-${randomBytes(3).toString("hex")}`;
  const dest = resolve(baseDir, destName);
  // Path jail: dest must be inside baseDir.
  if (!dest.startsWith(resolve(baseDir) + sep)) {
    return NextResponse.json({ success: false, error: "Invalid destination" }, { status: 400 });
  }

  // Build an authenticated clone URL when we have a token.
  let cloneUrl = url;
  if (token && url.startsWith("https://github.com/")) {
    cloneUrl = url.replace("https://github.com/", `https://${token}@github.com/`);
  }

  const args = ["clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  args.push(cloneUrl, dest);

  try {
    execFileSync("git", args, { stdio: "pipe", timeout: 120_000 });
  } catch (err) {
    try { await rm(dest, { recursive: true, force: true }); } catch {}
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString?.() || (err instanceof Error ? err.message : String(err));
    // Scrub token from any error message.
    const safe = token ? stderr.split(token).join("***") : stderr;
    return NextResponse.json({ success: false, error: safe.slice(0, 2000) }, { status: 500 });
  }

  // Persist a local registry entry so the repo can be listed/pulled later.
  try {
    const registryPath = join(baseDir, "repos.json");
    let registry: Array<Record<string, unknown>> = [];
    try {
      const raw = await (await import("fs/promises")).readFile(registryPath, "utf-8");
      registry = JSON.parse(raw);
    } catch {}
    registry.push({
      userId: session.user.id,
      name: destName,
      displayName: `${repo.owner}/${repo.name}`,
      url,
      path: dest,
      branch: branch || "default",
      clonedAt: new Date().toISOString(),
    });
    await (await import("fs/promises")).writeFile(registryPath, JSON.stringify(registry, null, 2));
  } catch {
    // Non-fatal.
  }

  // Persist a ProjectRecord so the repo shows up in the synced roster.
  try {
    await prisma.projectRecord.upsert({
      where: { userId_name: { userId: session.user.id, name: destName } },
      update: { lastOpenedAt: new Date() },
      create: { userId: session.user.id, name: destName, displayName: `${repo.owner}/${repo.name}` },
    });
  } catch {
    // Non-fatal: clone succeeded even if roster sync fails.
  }

  return NextResponse.json({
    success: true,
    path: dest,
    name: `${repo.owner}/${repo.name}`,
    branch: branch || "default",
  });
}