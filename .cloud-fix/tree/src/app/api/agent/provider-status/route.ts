import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { describeProviderSelection } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/provider-status — what provider is the harness running on?
 *
 * Pure env reading — no network, no key material returned (keyPresent is a
 * boolean, never the key). The Manager board renders this as a badge so the
 * user always knows whether they're in free-tier or BYOK mode.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  return NextResponse.json({
    success: true,
    ...describeProviderSelection(),
  });
}
