import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ notifications: [] });
    return NextResponse.json({ notifications: [
      { id: "1", message: "Welcome to Orplex Tech!", type: "info", read: false, createdAt: new Date().toISOString() },
    ] });
  } catch { return NextResponse.json({ notifications: [] }); }
}
