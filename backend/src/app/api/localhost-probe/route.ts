import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import net from "net";

export const dynamic = "force-dynamic";

const DEFAULT_PORTS = [3000, 5173, 8080, 4200, 3001, 8000, 5000, 4000];
const PROBE_TIMEOUT_MS = 900;

/**
 * POST /api/localhost-probe — Which local dev servers are actually running?
 *
 * Body: { ports?: number[] }
 * Returns: { live: number[], probed: number[] }
 *
 * The preview panel loads localhost URLs DIRECTLY in the iframe (no proxy —
 * the proxy breaks HMR websockets), so "the real localhost preview when the
 * server is running on the user's machine" already works — as long as the
 * user knows the port. This probe makes the new-tab page show LIVE servers
 * instead of static guesses. TCP connect is the truth: a listening socket is
 * a running server, no HTTP parsing needed.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let ports = DEFAULT_PORTS;
  try {
    const body = await request.json();
    if (Array.isArray(body?.ports)) {
      const filtered = body.ports
        .map((p: unknown) => Number(p))
        .filter((p: number) => Number.isInteger(p) && p > 0 && p < 65536)
        .slice(0, 12);
      if (filtered.length > 0) ports = filtered;
    }
  } catch {}

  const live = await Promise.all(
    ports.map(async (port) => {
      const open = await probePort(port);
      return open ? port : null;
    })
  ).then((results) => results.filter((p): p is number => p !== null));

  return NextResponse.json({ success: true, live, probed: ports });
}

function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}
