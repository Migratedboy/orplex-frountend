import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { appSessionUserFromRequest } from "@/lib/app-session";
import {
  deviceClients,
  githubAppSlug,
  pollDeviceFlow,
  startDeviceFlow,
  VERIFICATION_URI,
} from "@/lib/github-app";

export const dynamic = "force-dynamic";

/**
 * GitHub App device flow — the desktop's own sign-in for repository access.
 *
 *   POST            → { flowId, userCode, verificationUri, expiresIn, interval }
 *   GET ?flow=<id>  → { status: pending|slow_down|authorized|expired|denied|error,
 *                       login?, repos? }
 *
 * No redirect URI and no cookies: the user types the code at github.com, we poll
 * GitHub from here, and the resulting token is stored on this machine only.
 * Polling is deliberately one shot — the client sets the cadence from
 * `interval`, so a suspended laptop cannot turn into a request storm.
 */

async function resolveUserId(request: NextRequest): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (session?.user?.id) return session.user.id;
  const appUser = await appSessionUserFromRequest(request);
  return appUser?.id ?? null;
}

function unconfigured() {
  return NextResponse.json(
    {
      success: false,
      configured: false,
      error:
        "GitHub App sign-in is not configured. Set GITHUB_APP_CLIENT_ID after registering an app with device flow enabled.",
    },
    { status: 501 }
  );
}

export async function POST(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  if (deviceClients().length === 0) return unconfigured();

  try {
    const flow = await startDeviceFlow(userId);
    if (!flow) return unconfigured();
    return NextResponse.json({
      success: true,
      configured: true,
      slug: githubAppSlug(),
      ...flow,
      verificationUri: flow.verificationUri || VERIFICATION_URI,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Could not reach GitHub" },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  if (deviceClients().length === 0) return unconfigured();

  const flowId = new URL(request.url).searchParams.get("flow") || "";
  if (!flowId) {
    return NextResponse.json({ success: false, error: "Missing flow id" }, { status: 400 });
  }

  const result = await pollDeviceFlow(flowId, userId);
  return NextResponse.json({
    success: result.status === "authorized",
    status: result.status,
    login: result.login ?? null,
    ...(result.message ? { error: result.message } : {}),
  });
}
