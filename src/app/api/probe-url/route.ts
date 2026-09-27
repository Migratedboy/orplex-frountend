// probe-url route — reachability probe for the embedded browser's failure
// detection. Browser-side fetches can't probe cross-origin targets (CORS
// makes every response opaque), so the viewport asks the server instead.
// Session-gated like the rest of the app APIs and SSRF-guarded like the
// proxy: hostname shape + private-host blocklist + full DNS resolution.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import * as nodeDns from "node:dns/promises";
import { jwtOnlyOptions } from "@/lib/auth";
import { isProxiableUrl } from "@/lib/browser-proxy";
import { resolveTargetGuard } from "@/lib/proxy-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("url") || "";
  if (!isProxiableUrl(raw)) {
    return NextResponse.json({ ok: false, status: 0, error: "URL not allowed" }, { status: 403 });
  }

  try {
    const guard = await resolveTargetGuard(raw, (h) => nodeDns.lookup(h, { all: true }));
    if (!guard.ok) {
      return NextResponse.json({ ok: false, status: 0, error: guard.reason }, { status: 403 });
    }

    const res = await fetch(raw, {
      method: "HEAD",
      redirect: "manual", // presence of a redirect = reachable; no per-hop guarding needed here
      signal: AbortSignal.timeout(5_000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36" },
    });
    try { await res.body?.cancel(); } catch { /* drained */ }
    // Any answer at all (2xx/3xx/4xx/5xx) proves the server exists; 4xx/5xx
    // are surfaced as ok:false so the overlay can say "failed to load".
    return NextResponse.json({ ok: res.status < 400, status: res.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: 0, error: (err as Error).message.slice(0, 120) },
      { status: 200 }
    );
  }
}
