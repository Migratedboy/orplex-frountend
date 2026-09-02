import chalk from "chalk";
import ora from "ora";

interface ChatOptions {
  mode: string;
  url: string;
  apiKey?: string;
}

/**
 * Chat command — supports both interactive and pipe/stdin modes.
 *
 * Interactive: orplex chat "fix this bug in src/index.ts"
 * Pipe:       echo "what does this do?" | orplex chat
 */
export async function chatCommand(messageParts: string[], options: ChatOptions): Promise<void> {
  let message = messageParts.join(" ");

  // Pipe mode: read from stdin if no message argument
  if (!message && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    message = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!message) {
    console.log(chalk.dim("Type a message to chat with Orplex, or use --help for options."));
    console.log(chalk.dim(""));
    console.log(chalk.dim("Examples:"));
    console.log(chalk.dim('  orplex chat "fix this bug in src/index.ts"'));
    console.log(chalk.dim('  echo "explain this" | orplex chat'));
    console.log(chalk.dim("  cat error.log | orplex chat 'explain this error'"));
    return;
  }

  const spinner = ora("Thinking...").start();

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

    const res = await fetch(`${options.url}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: message }],
        conversationId: null,
        mode: options.mode,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }

    spinner.stop();

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    process.stdout.write(chalk.green("\n🤖 Orplex: "));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              process.stdout.write(parsed.content);
            }
          } catch {}
        }
      }
    }

    process.stdout.write("\n\n");
  } catch (err: unknown) {
    spinner.fail(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
