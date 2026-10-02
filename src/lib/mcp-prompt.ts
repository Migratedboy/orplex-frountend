// mcp-prompt.ts — MCP tool guidance block for the server agent's system
// prompt. Injected by the executor whenever MCP tools are present so the
// model uses them correctly and safely without per-server special cases.

/**
 * MCP usage rules for the agent. Kept compact (every line costs tokens on
 * every run that has MCP tools). Rendered after the tool roster.
 */
export function mcpUsageBlock(toolCount: number): string {
  return [
    `MCP tools (external services) are available this run (${toolCount} tools). They follow the naming pattern mcp__<server>__<tool>.`,
    `- Call them exactly like any other tool; arguments must match each tool's JSON schema.`,
    `- These services are REAL: writes (send message, create issue, deploy, payment) affect the user's account. Prefer reads; make writes only when the task clearly asks for them.`,
    `- A failed MCP call is information, not a dead end: read the error, adjust arguments, retry once, then continue the task without it and say what you could not do.`,
    `- Never invent MCP tools that are not in your tool roster, and never pass secrets into tool arguments — credentials are injected server-side.`,
  ].join("\n");
}

/**
 * One-line-per-server summary for the system prompt so the model knows what
 * each connected server IS (tool names alone are often cryptic).
 */
export function mcpServerSummaries(servers: Array<{ name: string; description: string; toolCount: number }>): string {
  return servers
    .map((s) => `- ${s.name} (${s.toolCount} tools): ${s.description.slice(0, 120)}`)
    .join("\n");
}
