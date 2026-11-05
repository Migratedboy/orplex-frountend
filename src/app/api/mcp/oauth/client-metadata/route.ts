// GET /api/mcp/oauth/client-metadata — Client-ID Metadata Document (CIMD).
//
// Served so that authorization servers advertising
// `client_id_metadata_document_supported` can fetch our client metadata
// instead of requiring a registered client. The `client_id` passed to those
// servers is this route's URL; the document's redirect_uris must match the
// redirect actually used (hosted callback). CIMD is only attempted when the
// redirect target is https (see flow.ts makeProvider).

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const callback = `${origin}/api/mcp/oauth/callback`;
  const doc = {
    client_id: `${origin}/api/mcp/oauth/client-metadata`,
    client_name: "Orplex",
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  return NextResponse.json(doc, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
