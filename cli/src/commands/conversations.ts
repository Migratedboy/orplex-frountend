import chalk from "chalk";

interface ConversationsOptions {
  url: string;
  apiKey?: string;
  limit?: number;
}

/**
 * Conversations command — list recent conversations from the server.
 *
 * Usage: orplex conversations [--limit 10]
 */
export async function conversationsCommand(options: ConversationsOptions): Promise<void> {
  const limit = options.limit || 10;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

    const res = await fetch(`${options.url}/api/conversations?limit=${limit}`, {
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }

    const data = (await res.json()) as { conversations?: Array<{ id: string; title: string; updatedAt: string; messages?: unknown[] }> };
    const conversations = data.conversations || [];

    if (conversations.length === 0) {
      console.log(chalk.dim("\nNo conversations found. Start one with: orplex chat \"hello\"\n"));
      return;
    }

    console.log(chalk.bold(`\n💬 Recent Conversations (${conversations.length})\n`));

    for (const conv of conversations) {
      const date = new Date(conv.updatedAt);
      const dateStr = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const msgCount = conv.messages?.length || 0;
      console.log(`  ${chalk.cyan(dateStr)}  ${conv.title || "Untitled"}  ${chalk.dim(`(${msgCount} messages)`)}  ${chalk.dim(conv.id.slice(0, 8))}`);
    }

    console.log("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch") || msg.includes("ECONNREFUSED")) {
      console.log(chalk.red(`\n✗ Cannot connect to ${options.url}`));
      console.log(chalk.dim("  Is the Orplex server running? Start it with: npm run dev\n"));
    } else {
      console.log(chalk.red(`\n✗ Error: ${msg}\n`));
    }
    process.exit(1);
  }
}
