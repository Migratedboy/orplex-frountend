// m3-client.ts — MiniMax M3 transport (OpenAI-compatible, NVIDIA endpoint).
//
// Extracted from the removed multi-agent.ts orchestration graph. Only the
// model transport survives — the coordinator/planner/coder graph itself was
// aspirational (its tool calls never executed) and is gone. Remaining
// consumers: sparc.ts and swarm.ts, which call M3 directly per phase/agent.

interface M3Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface M3Response {
  content: string;
  reasoning: string;
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

function getProviderConfig(): { url: string; key: string; model: string } {
  const nvKey = process.env.NVIDIA_API_KEY || "";

  if (nvKey) {
    return {
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      key: nvKey,
      model: process.env.NVIDIA_MODEL || "minimax/minimax-m3:free",
    };
  }
  throw new Error("No NVIDIA API key configured (NVIDIA_API_KEY)");
}

/**
 * Call M3 with messages — non-streaming, returns full response.
 */
export async function callM3(
  messages: M3Message[],
  maxTokens: number = 4096
): Promise<M3Response> {
  const config = getProviderConfig();

  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`M3 API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("M3 returned no choices");

  return {
    content: choice.message?.content || "",
    reasoning: choice.message?.reasoning || "",
    toolCalls: choice.message?.tool_calls || [],
  };
}

/**
 * Call M3 with tools — returns full response with tool calls.
 */
export async function callM3WithTools(
  systemPrompt: string,
  messages: M3Message[],
  tools: unknown[],
  maxTokens: number = 4096
): Promise<M3Response> {
  const config = getProviderConfig();

  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools,
      tool_choice: "auto",
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`M3 API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("M3 returned no choices");

  return {
    content: choice.message?.content || "",
    reasoning: choice.message?.reasoning || "",
    toolCalls: choice.message?.tool_calls || [],
  };
}

export type { M3Message, M3Response };
