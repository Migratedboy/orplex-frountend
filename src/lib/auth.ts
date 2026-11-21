import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import type { CookieOption } from "next-auth";

// ---------------------------------------------------------------------------
// Split-deployment cookie controls.
// Same parent domain (app.example.com + api.example.com): set
// AUTH_COOKIE_DOMAIN=.example.com and the session cookie just works.
// Unrelated domains: AUTH_COOKIE_SAMESITE=None (HTTPS required) so the
// browser accepts the cross-site cookie at all.
// ---------------------------------------------------------------------------
function splitDeploymentCookies(): Partial<Record<string, CookieOption>> | undefined {
  const domain = (process.env.AUTH_COOKIE_DOMAIN || "").trim();
  const sameSite = (process.env.AUTH_COOKIE_SAMESITE || "").trim().toLowerCase();
  if (!domain && !sameSite) return undefined;
  const useSecure = sameSite === "none" || process.env.NEXTAUTH_URL?.startsWith("https://") === true;
  const build = (name: string): CookieOption => ({
    name,
    options: {
      ...(domain ? { domain } : {}),
      ...(sameSite === "none" ? { sameSite: "none" as const } : {}),
      path: "/",
      secure: useSecure,
      // Overriding cookies replaces NextAuth's whole cookie definition —
      // without this the session token loses its HttpOnly flag and any XSS
      // can steal it.
      httpOnly: true,
    },
  });
  return {
    sessionToken: build("next-auth.session-token"),
    callbackUrl: build("next-auth.callback-url"),
    csrfToken: build("next-auth.csrf-token"),
    state: build("next-auth.state"),
    nonce: build("next-auth.nonce"),
  };
}

// Fail fast in production when secrets are missing — signing JWTs with
// `undefined` silently breaks all sessions and is undebuggable at runtime.
if (process.env.NODE_ENV === "production" && !String(process.env.NEXT_PHASE || "").includes("build") && !process.env.NEXTAUTH_SECRET) {
  throw new Error("[auth] NEXTAUTH_SECRET is unset in production — refusing to boot. Generate with: openssl rand -base64 32");
}

// Fail fast: localhost callback URLs on a cloud host break every OAuth flow
// (laptop dev values leaked into production env). Crash the boot loudly.
// Skipped during `next build` (NEXT_PHASE): static collection evaluates
// modules with build-time env; the running server enforces on boot.
if (
  process.env.NODE_ENV === "production" &&
  !String(process.env.NEXT_PHASE || "").includes("build") &&
  process.env.NEXTAUTH_URL &&
  /localhost|127\.0\.0\.1/.test(process.env.NEXTAUTH_URL)
) {
  throw new Error("[auth] NEXTAUTH_URL points at localhost in production — set it to the public app URL in the host dashboard.");
}

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();

const SPLIT_COOKIES = splitDeploymentCookies();


// Shared JWT callbacks — used by both full authOptions and lightweight jwtOnlyOptions.
// Keeping these in one place ensures session shape is consistent everywhere.
const jwtCallbacks: NextAuthOptions["callbacks"] = {
  async jwt({ token, user, account, profile }) {
    if (user) {
      token.id = user.id;
      token.image = user.image;
    }
    // Identity must follow the provider the user JUST signed in with.
    // With an adapter + JWT sessions, a linked provider re-auth reuses the
    // existing DB user, whose name/image are whatever the FIRST provider
    // stored — signing in with GitHub while the row was created via Google
    // kept showing the Google name + avatar. Refresh from the fresh OAuth
    // profile instead (GitHub → login/name + avatar_url, Google → name +
    // picture). The DB row sync lives only in the backend copy; self-hosted
    // mode treats the JWT as the single source of truth.
    if (account?.provider && profile) {
      const p = profile as { name?: string; login?: string; picture?: string; avatar_url?: string };
      const nextName = (p.name || (account.provider === "github" ? p.login : "")) || "";
      const nextImage = p.picture || p.avatar_url || "";
      if (nextName) token.name = nextName;
      if (nextImage) token.image = nextImage;
    }
    return token;
  },
  async session({ session, token }) {
    if (session.user) {
      session.user.id = token.id as string;
      session.user.image = token.image as string;
    }
    return session;
  },
};

/**
 * Full authOptions — includes PrismaAdapter + providers.
 * Use ONLY for the NextAuth route handler ([...nextauth]) where the adapter
 * and providers are needed for OAuth sign-in/sign-up flows.
 *
 * IMPORTANT: Do NOT import this in API route handlers. Use `jwtOnlyOptions` instead.
 * Importing this pulls in @prisma/client and triggers PrismaClient instantiation
 * + DB connection on cold start, even though JWT sessions never touch the database.
 */
export const authOptions: NextAuthOptions = {
  // Lazy-load PrismaAdapter only when this module is actually evaluated
  // (i.e., during OAuth flows in the [...nextauth] route handler).
  get adapter() {
    const { PrismaAdapter } = require("@next-auth/prisma-adapter");
    const { prisma } = require("../lib/prisma");
    return PrismaAdapter(prisma);
  },
  providers: [
    ...(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    // Only register GitHub provider when OAuth credentials are real (not placeholders).
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      && !process.env.GITHUB_CLIENT_ID.includes("your_")
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            // `repo` is what makes "Pull from GitHub" able to LIST the user's
            // private repositories, not just clone a URL they already know.
            // Tokens issued before this scope was requested keep working for
            // public repos; /api/repos/github reports needsScope and the picker
            // offers a reconnect instead of showing a misleadingly short list.
            authorization: { params: { scope: "read:user user:email repo" } },
            // NOTE: allowDangerousEmailAccountLinking is deliberately OFF —
            // with it, anyone can register a GitHub account on a victim's
            // email and inherit their Google-linked Orplex account (GitHub
            // does not require the email be verified for the link). Default
            // NextAuth behavior (verified-email-only linking) applies.
          }),
        ]
      : []),
  ],
  // 7-day sessions, refreshed on daily use: a stolen JWT dies within a week
  // instead of a month, and active users never notice the rotation.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  pages: { signIn: "/auth/signin" },
  ...(SPLIT_COOKIES ? { cookies: SPLIT_COOKIES } : {}),
  callbacks: {
    ...jwtCallbacks,
    // GitHub returns refresh_token_expires_in which Prisma schema doesnt have
    async signIn({ account }) {
      if (account) delete (account as any).refresh_token_expires_in;
      return true;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

/**
 * Lightweight JWT-only authOptions for getServerSession() in API routes.
 *
 * This skips the PrismaAdapter and providers entirely. Since we use JWT strategy,
 * session verification only needs: secret + session callback. No database access.
 * Importing this does NOT trigger PrismaClient initialization.
 *
 * Usage in API routes:
 *   import { jwtOnlyOptions } from "@/lib/auth";
 *   const session = await getServerSession(jwtOnlyOptions);
 */
export const jwtOnlyOptions: NextAuthOptions = {
  // providers is required by NextAuthOptions type but unused for JWT verification.
  // Empty array — getServerSession only reads secret + session callback.
  providers: [],
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  pages: { signIn: "/auth/signin" },
  ...(SPLIT_COOKIES ? { cookies: SPLIT_COOKIES } : {}),
  callbacks: jwtCallbacks,
  secret: process.env.NEXTAUTH_SECRET,
};