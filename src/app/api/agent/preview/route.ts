import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";

// In-memory preview store (per-session)
const previewStore = new Map<string, { url: string; html: string; timestamp: number }>();

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { url, action = "fetch" } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (action === "fetch") {
      // Fetch the URL content
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Orplex-Browser-Preview/1.0" },
        });
        clearTimeout(timeout);

        const contentType = res.headers.get("content-type") || "";
        const html = await res.text();

        // Store for later retrieval
        const previewId = `preview-${Date.now()}`;
        previewStore.set(previewId, { url, html, timestamp: Date.now() });

        // Clean old previews (keep last 10)
        if (previewStore.size > 10) {
          const oldest = Array.from(previewStore.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
          if (oldest) previewStore.delete(oldest[0]);
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
        return NextResponse.json({
          success: false,
          error: `Failed to fetch URL: ${(err as Error).message}`,
        }, { status: 502 });
      }
    }

    if (action === "list") {
      const previews = Array.from(previewStore.entries()).map(([id, p]) => ({
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
    return NextResponse.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const previewId = request.nextUrl.searchParams.get("id");
  if (!previewId) {
    return NextResponse.json({ error: "Preview ID required" }, { status: 400 });
  }

  const preview = previewStore.get(previewId);
  if (!preview) {
    return NextResponse.json({ error: "Preview not found" }, { status: 404 });
  }

  return new NextResponse(preview.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Preview-URL": preview.url,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() || "Untitled Page";
}
