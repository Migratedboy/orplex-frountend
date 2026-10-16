import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { urlError } from "@/lib/ssrf-guard";
import { randomUUID } from "crypto";

// In-memory preview store, scoped per user (a global map lets any logged-in
// user read anyone's preview by id).
const previewStore = new Map<string, Map<string, { url: string; html: string; timestamp: number }>>();
const MAX_PREVIEWS_PER_USER = 10;
/** Entries per user are capped, but the OUTER map was never pruned: a userId key
 *  plus up to 10 x 2MB of third-party HTML (~20MB) was pinned forever, even
 *  after the user closed the preview. On a warm serverless instance that
 *  accumulates across every user for the life of the lambda. */
const MAX_STALE_USER_STORES = 50;
/** Age at which an idle user's store is collected. */
const USER_STORE_TTL_MS = 60 * 60 * 1000;

/** Cap on fetched page bodies — an uncapped res.text() is an OOM vector. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Drop whole per-user stores that have gone cold, then bound the count.
 * Runs on every write, so it is amortised and cheap.
 */
function pruneUserStores(): void {
  const now = Date.now();
  for (const [uid, store] of previewStore) {
    if (!store.size) {
      previewStore.delete(uid);
      continue;
    }
    const newest = Math.max(...Array.from(store.values()).map((v) => v.timestamp));
    if (now - newest > USER_STORE_TTL_MS) previewStore.delete(uid);
  }
  while (previewStore.size > MAX_STALE_USER_STORES) {
    const oldest = previewStore.keys().next();
    if (oldest.done) break;
    previewStore.delete(oldest.value);
  }
}

function userStore(userId: string) {
  pruneUserStores();
  let m = previewStore.get(userId);
  if (!m) {
    m = new Map();
    previewStore.set(userId, m);
  }
  return m;
}

/** Read a response body with a hard byte budget (never res.text() unbounded). */
async function readCapped(res: Response, budget: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > budget) {
    throw new Error(`Response too large (${declared} bytes)`);
  }
  if (!res.body) {
    const text = await res.text();
    if (text.length > budget) throw new Error("Response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > budget) {
      await reader.cancel().catch(() => {});
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const { url, action = "fetch" } = body as { url?: unknown; action?: unknown };
    const userId = session.user.id;

    if (action === "fetch") {
      const blocked = urlError(url);
      if (blocked) {
        return NextResponse.json({ error: blocked }, { status: 400 });
      }
      // Fetch the URL content
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(url as string, {
          signal: controller.signal,
          headers: { "User-Agent": "Orplex-Browser-Preview/1.0" },
        });
        clearTimeout(timeout);

        const contentType = res.headers.get("content-type") || "";
        const html = await readCapped(res, MAX_PREVIEW_BYTES);

        // Store for later retrieval (per-user scope, unguessable ids)
        const store = userStore(userId);
        const previewId = `preview-${randomUUID()}`;
        store.set(previewId, { url: url as string, html, timestamp: Date.now() });

        // Clean old previews (keep last N per user)
  // Clean old previews (keep last N per user). The previous single eviction ran
  // only when the size exceeded the cap by exactly one, so the store stabilised
  // at 11 entries instead of 10.
  while (store.size > MAX_PREVIEWS_PER_USER) {
    const oldest = Array.from(store.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (!oldest) break;
    store.delete(oldest[0]);
  }

        return NextResponse.json({
          success: true,
          previewId,
          contentType,
          html,
          title: extractTitle(html),
          statusCode: res.status,
          size: html.length,
        });
      } catch (err) {
        clearTimeout(timeout);
        return NextResponse.json(
          { success: false, error: "Failed to fetch URL" },
          { status: 502 }
        );
      }
    }

    if (action === "list") {
      const previews = Array.from(userStore(userId).entries()).map(([id, p]) => ({
        id,
        url: p.url,
        title: p.html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "Untitled",
        timestamp: p.timestamp,
        size: p.html.length,
      }));
      return NextResponse.json({ previews });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  // Auth check
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const previewId = request.nextUrl.searchParams.get("id");
  if (!previewId) {
    return NextResponse.json({ error: "Preview ID required" }, { status: 400 });
  }

  // Scoped read: a user can only render their own previews.
  const preview = previewStore.get(session.user.id)?.get(previewId);
  if (!preview) {
    return NextResponse.json({ error: "Preview not found" }, { status: 404 });
  }

  return new NextResponse(preview.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Sandboxed render + no cross-origin sharing: stored third-party HTML
      // must never run with ambient authority or exfiltrate elsewhere.
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "X-Preview-URL": preview.url,
    },
  });
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() || "Untitled Page";
}
