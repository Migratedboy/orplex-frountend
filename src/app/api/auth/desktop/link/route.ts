import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { mintDesktopGrant } from "@/lib/desktop-auth";
import { checkRateLimit, clientIp } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

/**
 * Site-mediated desktop sign-in (the mediator model).
 *
 * The SITE (orplex-code.vercel.app) owns the whole OAuth round-trip: the
 * user signs in there (GitHub / Google / email magic link) and the session
 * cookie lands on the SITE origin. When the page was opened by the desktop
 * app (`/login?app=auth`), its JS calls /api/auth/desktop/link — through the
 * site's rewrite to the backend in cloud mode, or HERE when the app
 * self-hosts. This local copy mirrors the backend route so both modes mint
 * the same short-lived encrypted grant that /api/auth/desktop/exchange
 * redeems.
 *
 * No CSRF token required: the NextAuth session cookie is SameSite=Lax, so a
 * cross-site form POST never carries it. Rate limiting + the 401 gate are
 * the abuse controls.
 */
export async function POST(request: Request) {
  const rl = checkRateLimit(`desktop-link:${clientIp(request)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts — wait a minute and try again." },
      { status: 429 }
    );
  }

  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) {
    // Generic message on purpose: don't reveal whether the session cookie
    // was absent, expired, or invalid — all mean "go sign in first".
    return NextResponse.json(
      { ok: false, error: "Sign in on the website first, then return to the app." },
      { status: 401 }
    );
  }

  const grant = mintDesktopGrant({
    id: (session.user as { id?: string }).id || session.user.email || "",
    name: session.user.name,
    email: session.user.email,
    image: session.user.image ?? null,
  });

  return NextResponse.json({
    ok: true,
    grant,
    user: {
      id: (session.user as { id?: string }).id,
      email: session.user.email,
      name: session.user.name,
    },
  });
}
