// mcp-gateway.ts — Shared auth helpers for the MCP gateway route.
//
// The gateway is for LOCAL machine-to-machine use (the stdio proxy script
// talking to the local Orplex server), so it deliberately bypasses NextAuth
// cookies — but never silently: it requires ORPLEX_MCP_TOKEN to be set, and
// attributes every run to the single local user resolved from the DB.

const TOKEN_LENGTH_CAP = 256;

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

/** The one local user runs are attributed to (first by creation). */
export async function resolveLocalUser(): Promise<string | null> {
  try {
    const { prisma } = await import("./prisma");
    const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    return user?.id ?? null;
  } catch {
    return null;
  }
}
