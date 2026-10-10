import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

const handler = NextAuth(authOptions);

// Wrap with error resilience — if Prisma/DB is unreachable, return
// an empty session instead of crashing with 500 (which sends HTML
// to the client and breaks the JSON parser).
async function resilientHandler(
  req: Request,
  ctx: { params: Promise<{ nextauth: string[] }> }
) {
  try {
    return await handler(req, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Config errors (missing secret, bad provider) must surface as 500 so
    // deploys alert — only DB-connectivity outages get the empty-session fallback.
    if (/secret|configuration|clientid|client_secret|provider/i.test(msg)) {
      console.error("[NextAuth] Configuration error — refusing to mask as empty session:", err);
      return NextResponse.json({ error: "Auth misconfigured" }, { status: 500 });
    }
    console.error("[NextAuth] Handler error (DB unreachable?)", err);
    // Return empty session so client doesn't get HTML parser error
    return NextResponse.json({}, { status: 200 });
  }
}

export { resilientHandler as GET, resilientHandler as POST };
