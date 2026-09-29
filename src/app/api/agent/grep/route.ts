// /api/agent/grep — Real code search over the caller's registered workspace.
//
// SECURITY MODEL (mirrors /api/agent/exec): the search runs in the CALLER's
// per-user workspace cwd (getWorkspaceCwdForUser), never a shared root. The
// pattern is length-capped and the engine list is the Windows-safe chain in
// lib/grep-search.ts (rg → git grep → node scan). Read-only by construction —
// no shell, execFile with fixed argv, output capped before it leaves the lib.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import { grepSearch, codeSearch } from "@/lib/grep-search";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  let body: { pattern?: unknown; isRegex?: unknown; mode?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  if (!pattern) {
    return NextResponse.json({ success: false, error: "pattern required" }, { status: 400 });
  }

  const cwd = getWorkspaceCwdForUser(session.user.id);
  if (!cwd) {
    return NextResponse.json(
      { success: false, error: "No workspace registered — open a folder first" },
      { status: 400 }
    );
  }

  // mode=snippets → code_search: grouped context snippets + read_file hints.
  const result =
    body.mode === "snippets"
      ? await codeSearch(cwd, pattern, {
          isRegex: body.isRegex === true,
          context: typeof body.context === "number" ? body.context : undefined,
        })
      : await grepSearch(cwd, pattern, { isRegex: body.isRegex === true });
  if (!result) {
    return NextResponse.json({ success: false, error: "No search engine available" }, { status: 500 });
  }

  return NextResponse.json({ success: true, ...result });
}
