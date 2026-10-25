// ingest — POST the rescue-published model catalog snapshot.
//
// The long-lived local app runs a real probe sweep the serverless backend
// can't; when the server's own /api/models/available looks empty or stale,
// the client renders the local list AND publishes it here (see
// ChatInput.tsx rescueFromServerless). Later server-side cold starts serve
// that snapshot instead of an empty picker.
//
// Monotonic on probedAt: an older snapshot arriving late must never replace
// a newer one (src/lib/catalog-ingest.ts owns that invariant).

import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import { writeIngestedCatalog } from "@/lib/catalog-ingest";

export const dynamic = "force-dynamic";

// 2 MB body cap — a full sweep is ~340 model records × ~150 bytes, an order
// of magnitude below this; the cap only binds hostile payloads.
const MAX_BODY_BYTES = 2_000_000;

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    // Content-length comes from the client; the body read below is the real
    // bound for lying headers.
    if (length > MAX_BODY_BYTES) {
      return Response.json({ success: false, error: { message: "Payload too large" } }, { status: 413 });
    }
    const raw = (await request.json().catch(() => null)) as unknown;
    const result = writeIngestedCatalog(raw);
    if (!result.ok) {
      return Response.json(
        { success: false, error: { message: "Invalid catalog payload" } },
        { status: 400 }
      );
    }
    return Response.json({ success: true, replaced: result.replaced });
  } catch {
    // The publisher treats any non-ok as "rescue skipped" — stay 200-safe
    // about ephemeral storage trouble rather than alarming the picker. But a
    // hard failure is still reported as an error status so real bugs surface
    // in server logs.
    return Response.json(
      { success: false, error: { message: "Failed to store catalog snapshot" } },
      { status: 503 }
    );
  }
}
