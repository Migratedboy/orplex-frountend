import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";


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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaAdapter } = require("@next-auth/prisma-adapter");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require("@/lib/prisma");
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
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/auth/signin" },
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
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/auth/signin" },
  callbacks: jwtCallbacks,
  secret: process.env.NEXTAUTH_SECRET,
};