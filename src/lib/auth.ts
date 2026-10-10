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

const SPLIT_COOKIES = splitDeploymentCookies();


// Shared JWT callbacks — used by both full authOptions and lightweight jwtOnlyOptions.
// Keeping these in one place ensures session shape is consistent everywhere.
const jwtCallbacks: NextAuthOptions["callbacks"] = {
  async jwt({ token, user }) {
    if (user) {
      token.id = user.id;
      token.image = user.image;
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
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // Only register GitHub provider when OAuth credentials are real (not placeholders).
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      && !process.env.GITHUB_CLIENT_ID.includes("your_")
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
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