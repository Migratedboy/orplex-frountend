import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { PLUGIN_REGISTRY, getEnabledPlugins, enablePlugin, disablePlugin } from "@/lib/plugins/initializer";

export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const enabled = getEnabledPlugins();
    const plugins = PLUGIN_REGISTRY.map(p => ({
      name: p.name,
      category: p.category,
      description: p.description,
      enabled: enabled.has(p.name),
    }));

    return NextResponse.json({ plugins });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { name, enabled } = body;

    if (!name || typeof enabled !== "boolean") {
      return NextResponse.json({ error: "name and enabled required" }, { status: 400 });
    }

    if (enabled) {
      enablePlugin(name);
    } else {
      disablePlugin(name);
    }

    return NextResponse.json({ success: true, name, enabled });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
