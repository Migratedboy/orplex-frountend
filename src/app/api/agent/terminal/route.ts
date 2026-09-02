import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { command } = await request.json();
    if (!command || typeof command !== "string") {
      return NextResponse.json({ error: "No command provided" }, { status: 400 });
    }

    // Basic safety: block dangerous commands
    const blocked = ["rm -rf", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
    if (blocked.some(b => command.toLowerCase().includes(b))) {
      return NextResponse.json({ error: "Command blocked for safety" }, { status: 403 });
    }

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: process.env.WORKSPACE_DIR || process.cwd(),
    });

    const output = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
    const truncated = output.length > 10000 ? output.slice(0, 10000) + "\n... [truncated]" : output;

    return NextResponse.json({ output: truncated || "(no output)" });
  } catch (err: any) {
    const output = (err.stdout || "") + (err.stderr ? `\nSTDERR: ${err.stderr}` : "");
    return NextResponse.json({
      output: output || err.message || "Command failed",
      error: true,
    });
  }
}
