import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { prisma } from "@/lib/prisma";
import { execFileSync } from "child_process";
import { rm, stat } from "fs/promises";
import { join } from "path";
import { backendJson } from "@/lib/backend-client";
import { readGithubToken } from "@/lib/github-app";
import { resolveProjectDir, createProjectDir } from "@/lib/project-paths";

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
  const userId = await sessionUserId(request);
  if (!userId) {
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
  const credential = await readGithubToken(userId);
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

  // Destination: <parent>/<name>. The name is the project name the user typed,
  // so the folder on disk is the project in the sidebar — the old
  // "<owner>-<repo>-<random>" directory made every clone look like a stranger.
  const wanted = typeof body?.name === "string" ? body.name.trim() : "";
  const parent = body?.parent;
  let dest: string;
  let projectName: string;
  if (wanted) {
    const target = await resolveProjectDir(wanted, parent);
    if (!target.ok) {
      return NextResponse.json({ success: false, error: target.error }, { status: target.status });
    }
    // A folder that already exists is a real error: git would either refuse or
    // (with an empty dir) quietly clone into foreign surroundings.
    if (await stat(target.path).catch(() => null)) {
      return NextResponse.json(
        { success: false, error: `A folder named "${target.name}" already exists there` },
        { status: 409 }
      );
    }
    const made = await createProjectDir(target.name, parent);
    if (!made.ok) {
      return NextResponse.json({ success: false, error: made.error }, { status: made.status });
    }
    dest = made.path;
    projectName = made.name;
  } else {
    // Legacy path (no name): a scratch directory next to the app data.
    const baseDir = process.env.ORPLEX_REPOS_DIR || join(process.cwd(), ".orplex-repos");
    const made = await createProjectDir(`${safeDestName(repo.owner)}-${safeDestName(repo.name)}`, baseDir).catch(
      () => null
    );
    if (!made || !made.ok) {
      return NextResponse.json(
        { success: false, error: made && !made.ok ? made.error : "Could not create the clone destination" },
        { status: made && !made.ok ? made.status : 500 }
      );
    }
    dest = made.path;
    projectName = made.name;
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
    const registryPath = join(dest, "..", "repos.json");
    let registry: Array<Record<string, unknown>> = [];
    try {
      const raw = await (await import("fs/promises")).readFile(registryPath, "utf-8");
      registry = JSON.parse(raw);
    } catch {}
    registry.push({
      userId: userId,
      name: projectName,
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
      where: { userId_name: { userId: userId, name: projectName } },
      update: { lastOpenedAt: new Date() },
      create: { userId: userId, name: projectName, displayName: `${repo.owner}/${repo.name}` },
    });
  } catch {
    // Non-fatal: clone succeeded even if roster sync fails.
  }

  return NextResponse.json({
    success: true,
    path: dest,
    name: projectName,
    fullName: `${repo.owner}/${repo.name}`,
    branch: branch || "default",
  });
}