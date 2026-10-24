// POST /api/agent/sandbox/artifact-serve — [ARTIFACT] server mode.
//
// The AI emits an artifact with a server block (a python/node app + an entry
// file). This route uploads the files, installs deps when needed, starts the
// declared server process DETACHED inside a Vercel Sandbox VM, polls the
// public domain of the exposed port, and hands back the URL. The UI embeds
// that URL in the same iframe slot so the interactive server app runs in the
// SUT world. Auth requires the session; caps match the render parser.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { parseArtifactPayload } from "@/lib/artifact-sandbox";
import { isVercelSandboxAvailable, serveSandboxApp } from "@/lib/vercel-sandbox";
import { publicErrorMessage } from "@/lib/errors";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await checkBurstLimit(userId).catch(() => false))) {
      return Response.json({ error: "Too many requests. Try again in about a minute." }, { status: 429, headers: { "Retry-After": "60" } });
    }
    if (!(await isVercelSandboxAvailable())) {
      return Response.json({ error: "Sandbox execution is unavailable on this deployment." }, { status: 403 });
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = parseArtifactPayload(body);
    if (!parsed.ok || !parsed.artifact) {
      return Response.json({ error: parsed.error || "invalid artifact payload" }, { status: 400 });
    }

    const { files, entry, language } = parsed.artifact;
    const served = await serveSandboxApp({
      userId,
      family: "serve",
      language,
      files: files.map((f) => ({ path: f.path, content: f.content })),
      entry,
    });
    if (!served.ready) {
      return Response.json(
        { error: served.logTail || "server did not come up in time", url: served.url },
        { status: 504 }
      );
    }
    return Response.json({
      ok: true,
      url: served.url,
      port: served.port,
      durationMs: served.durationMs,
    });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Sandbox serve failed") },
      { status: 500 }
    );
  }
}
