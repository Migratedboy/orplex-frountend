// mcp-auth.ts — session reader for the locally-served MCP routes.
//
// Conflict C2 keeps /api/mcp/* and /api/agent/mcp/* executing in THIS
// process, but the session cookie is issued by the https backend (proxied
// /api/auth/*) or the desktop exchange — i.e. __Secure-next-auth.session-token.
// jwtOnlyOptions derives the plain next-auth.session-token name from
// NEXTAUTH_URL=http://..., so getServerSession() alone finds no cookie on
// local routes and every MCP handler 401s. Same dual-name tolerance as the
// page-auth check in proxy.ts; verification is unchanged (local NEXTAUTH_SECRET).

import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { decode } from "next-auth/jwt";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type McpSession = { user: { id: string } };

/** The session user lives in Supabase; FK-backed local writes (mcpServerConfig,
 *  mcpOAuthPending, mcpTool, …) 500 without a matching row in the LOCAL users
 *  table. Mirrors the upsert in /api/auth/desktop/exchange so web-signed-in
 *  users get the same guarantee at the route boundary. Best-effort: a unique
 *  email collision under another id (prior dev session) must not 401 the
 *  session. */
async function ensureLocalUser(id: string, name?: string | null, email?: string | null): Promise<void> {
  try {
    await prisma.user.upsert({
      where: { id },
      update: { name: name ?? undefined, email: email ?? undefined },
      create: { id, name: name ?? "Orplex User", email: email ?? null },
    });
  } catch {
    try {
      await prisma.user.upsert({
        where: { id },
        update: { name: name ?? undefined },
        create: { id, name: name ?? "Orplex User" },
      });
    } catch {
      // row may already exist — writes-by-FK callers will surface real errors
    }
  }
}

/** Signed-in user for a local MCP route, or null when no valid session
 *  cookie (either name) is present. */
export async function getMcpSession(): Promise<McpSession | null> {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const id = session?.user?.id;
    if (id) {
      await ensureLocalUser(id, session?.user?.name, session?.user?.email);
      return { user: { id } };
    }
  } catch {
    // fall through to the __Secure- cookie below
  }
  try {
    const raw = (await cookies()).get("__Secure-next-auth.session-token")?.value;
    const secret = process.env.NEXTAUTH_SECRET;
    if (!raw || !secret) return null;
    // No salt: session tokens derive the encryption key with salt "" (v4 default).
    const token = await decode({ token: raw, secret });
    const id = token?.id ?? token?.sub;
    if (typeof id !== "string" || id.length === 0) return null;
    await ensureLocalUser(id, token?.name, token?.email);
    return { user: { id } };
  } catch {
    return null;
  }
}
