"use client";

import { useRef, useCallback } from "react";
import { startBackgroundKeeper, stopBackgroundKeeper } from "@/lib/bg-keeper";

interface StreamOptions {
  messages: { role: string; content: string; images?: string[] }[];
  conversationId: string | null;
  onChunk: (content: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export function useSSEStream() {
  const abortRef = useRef<AbortController | null>(null);

  const stream = useCallback(async (options: StreamOptions) => {
    const { messages, conversationId, onChunk, onDone, onError } = options;

    try {
      abortRef.current = new AbortController();
      startBackgroundKeeper();

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, conversationId: conversationId || undefined }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error?.message || err.error || err.message || `HTTP ${res.status}`;
        throw new Error(typeof msg === "string" ? msg : `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let streamedContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "rate_limit_retry") {
                // Show retry countdown in UI
                onChunk(streamedContent + `

[Rate limited. Retrying in ${parsed.waitTime}s... (${parsed.attempt}/${parsed.maxAttempts})]`);
              } else if (parsed.content) {
                streamedContent += parsed.content;
                onChunk(streamedContent);
              }
            } catch {}
          }
        }
      }

      onDone();
      return streamedContent;
    } catch (err) {
      if ((err as Error).name === "AbortError") return null;
      onError(err as Error);
      return null;
    } finally {
      abortRef.current = null;
      stopBackgroundKeeper();
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { stream, stop, isStreaming: !!abortRef.current };
}
