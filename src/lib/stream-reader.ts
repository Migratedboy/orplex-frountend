// stream-reader.ts — SSE stream reader for LLM responses
// Handles both legacy XML tool calls and M3 native tool_calls + thinking content

// === Token deduplication ===
// GPT-OSS-120B sometimes outputs repeated words: "the the rule rule"
export function deduplicateWords(text: string): string {
  // Collapse "word word" → "word" (case-insensitive, word-boundary aware)
  // Two-pass handles triple+ duplicates: "a a a" → "a a" → "a"
  let prev: string;
  do {
    prev = text;
    text = text.replace(/(\b\w+\b)\s+\1\b/gi, "$1");
  } while (text !== prev);
  return text;
}

// === Tool call types ===

export interface ToolCall {
  name: string;
  path?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  query?: string;
  command?: string;
  url?: string;
  action?: string;
  items?: string[];
  completed_index?: number;
  question?: string;
  options?: string[];
  allow_free_text?: boolean;
  edits?: { path: string; old_text: string; new_text: string }[];
  timeout?: number;
}

// === Parse legacy XML tool calls ===

export function parseToolCalls(text: string): ToolCall[] {
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      calls.push(JSON.parse(match[1].trim()));
    } catch {}
  }
  return calls;
}

// === Status line replacement ===

export function replaceLastStatus(display: string, resultLine: string): string {
  const statusRegex = /^(analysing|reading|writing|listing|thinking)\s+\[[^\]]+\]\n?$/m;
  const lines = display.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (statusRegex.test(lines[i])) {
      lines[i] = resultLine;
      return lines.join("\n");
    }
  }
  return display + resultLine + "\n";
}

// === Accumulated native tool call state (M3 streams tool calls across multiple deltas) ===

interface NativeToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

// === Stream reader ===

export interface StreamResult {
  content: string | null;
  thinking: string;
  toolCalls: ToolCall[];
}

export interface StreamCallbacks {
  onChunk: (content: string) => void;
  onThinking?: (thinking: string) => void;
}

export async function readStream(
  messages: { role: string; content: string }[],
  conversationId: string | null,
  callbacks: StreamCallbacks,
  mode: string = "ask",
  images: string[] = []
): Promise<StreamResult> {
  const { onChunk, onThinking } = callbacks;

  // Retry logic for rate limits (429)
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        conversationId: conversationId || undefined,
        mode,
        images: images.length > 0 ? images : undefined,
      }),
    });

    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "60", 10);
      console.log(`[RATE-LIMIT] readStream hit 429. Retrying in ${retryAfter}s... (${attempt}/3)`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({})) || {};
    throw new Error(err.error?.message || `HTTP ${res?.status || "unknown"}`);
  }

  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let streamedContent = "";
  let thinkingContent = "";
  const accumulatorMap = new Map<number, NativeToolCallAccumulator>();
  const TIMEOUT_MS = 300_000; // 300s — Kimi K3 needs time to think

  while (true) {
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
      setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS);
    });
    const result = await Promise.race([reader.read(), timeoutPromise]);
    if (result.done) break;
    const chunk = decoder.decode(result.value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);

          // 1. Regular text content
          if (parsed.content) {
            streamedContent += parsed.content;
            onChunk(deduplicateWords(streamedContent));
          }

          // 2. Thinking/reasoning content
          const reasoningText = parsed.thinking || parsed.reasoning_content;
          if (reasoningText) {
            thinkingContent += reasoningText;
            onThinking?.(reasoningText);
          }

          // 3. M3 native tool calls — accumulate fragments by index
          if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
            for (const tc of parsed.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulatorMap.has(idx)) {
                accumulatorMap.set(idx, { index: idx, arguments: "" });
              }
              const acc = accumulatorMap.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
  }

  // Finalize accumulated native tool calls
  const nativeToolCalls: ToolCall[] = [];
  for (const [, acc] of accumulatorMap) {
    if (acc.name) {
      const call: ToolCall = { name: acc.name };
      if (acc.arguments) {
        try {
          const args = JSON.parse(acc.arguments);
          if (args.path) call.path = args.path;
          if (args.content) call.content = args.content;
          if (args.old_text) call.old_text = args.old_text;
          if (args.new_text) call.new_text = args.new_text;
          if (args.query) call.query = args.query;
          if (args.command) call.command = args.command;
          if (args.url) call.url = args.url;
          if (args.action) call.action = args.action;
          if (args.items) call.items = args.items;
          if (args.completed_index !== undefined) call.completed_index = args.completed_index;
          if (args.question) call.question = args.question;
          if (args.options) call.options = args.options;
          if (args.allow_free_text !== undefined) call.allow_free_text = args.allow_free_text;
          if (args.edits && Array.isArray(args.edits)) call.edits = args.edits;
        } catch {}
      }
      nativeToolCalls.push(call);
    }
  }

  // Also parse legacy XML tool calls from content (backward compat)
  const legacyToolCalls = parseToolCalls(streamedContent);
  const allToolCalls = [...nativeToolCalls, ...legacyToolCalls];

  return { content: streamedContent || null, thinking: thinkingContent, toolCalls: allToolCalls };
}
