// Sync hub — push endpoint. Peers post gzip sync envelopes signed with the
// shared secret (ORPLEX_SYNC_HUB_SECRET); the hub merges entries into its
// per-workspace sync store. The hub never executes entries — it's a mailbox.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  decodeEnvelope,
  verifySignature,
  MAX_SYNC_ENTRIES_PER_PULL,
} from "@/lib/sync-transport";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const secret = process.env.ORPLEX_SYNC_HUB_SECRET;
    if (!secret) {
      return NextResponse.json({ error: "Sync hub not enabled (ORPLEX_SYNC_HUB_SECRET unset)" }, { status: 503 });
    }

    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length === 0) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    const signature = request.headers.get("X-Orplex-Sync-Signature") || "";
    if (!verifySignature(raw.toString("base64"), signature, secret)) {
      return NextResponse.json({ error: "Invalid sync signature" }, { status: 401 });
    }

    let env;
    try {
      env = decodeEnvelope(raw);
    } catch (err) {
      return NextResponse.json({ error: `Bad envelope: ${(err as Error).message}` }, { status: 400 });
    }

    if (!env.machineId || !Array.isArray(env.entries)) {
      return NextResponse.json({ error: "Envelope missing machineId or entries" }, { status: 400 });
    }

    const userId = (session.user as { id?: string }).id || "unknown";
    let accepted = 0;
    for (const entry of env.entries.slice(0, MAX_SYNC_ENTRIES_PER_PULL)) {
      if (!entry || typeof entry.id !== "string" || !entry.id) continue;
      await prisma.syncEvent.upsert({
        where: { id: entry.id },
        create: {
          id: entry.id,
          userId,
          machineId: String(env.machineId).slice(0, 64),
          payload: JSON.stringify(entry).slice(0, 16_000),
          at: typeof entry.at === "string" ? new Date(entry.at) : new Date(),
        },
        update: {}, // idempotent: an entry already received is a no-op
      });
      accepted++;
    }

    return NextResponse.json({ accepted });
  } catch (err) {
    return NextResponse.json({ error: "Sync push failed" }, { status: 500 });
  }
}
