// skills — user-authored SKILL.md discovery for the CHAT lane.
//
// GET /api/agent/skills          → { roster, skills: [{name, description, whenToUse?, source}] }
// GET /api/agent/skills?name=…   → { name, body, source }  (404 when unknown)
//
// The server/worktree lane loads skills in-process (executor.ts); the browser
// chat lane cannot read the workspace from the renderer, so /api/chat puts the
// roster in the system prompt from the same loader and the `use_skill` tool
// fetches the body here. Both lanes therefore see the same skills, the same
// precedence (project over user) and the same limits.

import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { loadUserSkills, renderSkillRoster, findSkill } from "@/lib/user-skills";

export const dynamic = "force-dynamic";

const err = (status: number, message: string) => NextResponse.json({ success: false, error: message }, { status });

export async function GET(request: NextRequest) {
  // sessionUserId, NOT getServerSession(jwtOnlyOptions): the packaged desktop
  // app ships no NEXTAUTH_SECRET and signs in with the Ed25519 app-session
  // cookie instead. getServerSession cannot read that cookie, so this route
  // answered 401 for the very lane use_skill runs in (every other LOCAL_ONLY
  // route already authenticates this way).
  const userId = await sessionUserId(request);
  if (!userId) return err(401, "Authentication required");

  // No registered folder → no project skills. Not an error: the chat lane
  // still works, it simply has nothing to advertise.
  const root = await resolveWorkspaceCwd(userId);
  if (!root) return NextResponse.json({ success: true, roster: "", skills: [] });

  const name = request.nextUrl.searchParams.get("name");
  try {
    const skills = await loadUserSkills(root);
    if (name !== null) {
      const skill = findSkill(skills, name);
      if (!skill) {
        // Include the roster in the miss so the model can correct a typo or
        // pick a real skill instead of guessing again.
        return NextResponse.json(
          { success: false, error: `skill "${name.slice(0, 80)}" not found`, roster: renderSkillRoster(skills) },
          { status: 404 },
        );
      }
      return NextResponse.json({
        success: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse ?? null,
        source: skill.source,
        body: skill.body,
      });
    }
    return NextResponse.json({
      success: true,
      roster: renderSkillRoster(skills),
      skills: skills.map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse ?? null, source: s.source })),
    });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : "failed to load skills");
  }
}
