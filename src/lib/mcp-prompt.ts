// mcp-prompt.ts — MCP tool guidance block for the server agent's system
// prompt. Injected by the executor whenever MCP tools are present so the
// model uses them correctly and safely without per-server special cases.

/**
 * One-line-per-server summary for the system prompt so the model knows what
 * each connected server IS (tool names alone are often cryptic).
 */
export function mcpServerSummaries(servers: Array<{ name: string; description: string; toolCount: number }>): string {
  return servers
    .map((s) => `- ${s.name} (${s.toolCount} tools): ${s.description.slice(0, 120)}`)
    .join("\n");
}

/**
 * MCP usage rules for the agent. Kept compact (every line costs tokens on
 * every run that has MCP tools). Rendered after the tool roster.
 *
 * Now also explains the discovery tools that appear even under the cap (see
 * tool-builder — mcp_search_tools + mcp_describe_tool are always present so
 * the model can find tools not shown in the roster).
 */
export function mcpUsageBlock(toolCount: number): string {
  return [
    `MCP tools (external services) are available this run (${toolCount} tools). They follow the naming pattern mcp__<server>__<tool>.`,
    `- Call them exactly like any other tool; arguments must match each tool's JSON schema.`,
    `- These services are REAL: writes (send message, create issue, deploy, payment) affect the user's account. Prefer reads; make writes only when the task clearly asks for them.`,
    `- A failed MCP call is information, not a dead end: read the error, adjust arguments, retry once, then continue the task without it and say what you could not do.`,
    `- Never invent MCP tools that are not in your tool roster, and never pass secrets into tool arguments — credentials are injected server-side.`,
    `- To find a tool by name/description/server, call mcp_search_tools({ query: "..." }). To get a tool's exact parameters, call mcp_describe_tool({ tool: "mcp__<server>__<tool>" }).`,
  ].join("\n");
}
