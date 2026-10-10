// mcp-gateway.ts — Shared auth helpers for the MCP gateway route.
//
// The gateway is for LOCAL machine-to-machine use (the stdio proxy script
// talking to the local Orplex server), so it deliberately bypasses NextAuth
// cookies — but never silently: it requires ORPLEX_MCP_TOKEN to be set, and
// attributes every run to a single user (see resolveLocalUser).

// Generous cap: tokens are short, but a hard 256 rejects legitimately long
// operator-generated secrets with a misleading "invalid" (indistinguishable
// from a wrong token). Comparison cost stays trivial at this bound.
const TOKEN_LENGTH_CAP = 4096;

/** Constant-time string comparison (no early exit on content mismatch). */
export function timingSafeTokenCompare(a: string, b: string): boolean {
  if (a.length > TOKEN_LENGTH_CAP || b.length > TOKEN_LENGTH_CAP) return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The user gateway runs are attributed to. Prefer an explicit binding
 * (ORPLEX_MCP_USER_ID) — otherwise the first-created user, which is only
 * correct on single-user machines. On a shared host, ALWAYS set the env var:
 * otherwise every token holder acts as the oldest account.
 */
export async function resolveLocalUser(): Promise<string | null> {
  try {
    const pinned = process.env.ORPLEX_MCP_USER_ID;
    const { prisma } = await import("./prisma");
    if (pinned) {
      const user = await prisma.user.findUnique({ where: { id: pinned }, select: { id: true } });
      return user?.id ?? null;
    }
    const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    return user?.id ?? null;
  } catch {
    return null;
  }
}
