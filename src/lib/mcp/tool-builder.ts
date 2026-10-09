// tool-builder.ts — the ONE MCP tool-array builder both agent lanes feed (C5).
//
// Pure: no Prisma, no hub, no localStorage — callers hand in tools from their
// own store (localStorage remotes, the Prisma McpTool snapshot, or an in-run
// tools/list) and get back model defs, the prompt roster, server summaries,
// and the over-cap meta tools.
//
// Over-cap policy (C10): more than MCP_TOOL_CAP tools → names-only defs for
// EVERY tool (never a silent drop — no slice()) plus mcp_search_tools /
// mcp_describe_tool so the model can page in exact schemas on demand.
// schemaChars is what the prompt meter accounts against MCP schemas.

import { mcpToolName, type McpToolAnnotations } from "./registry";

export interface BuilderTool {
  /** serverId — catalog slug or legacy remote id (the mcp__ segment). */
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: McpToolAnnotations;
}

/** Flat function def — executor NativeToolDef shape; wrap for OpenAI with toOpenAiFunction. */
export interface McpModelToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpServerSummary {
  /** serverId (the mcp__ segment). */
  name: string;
  /** Display label (catalog name / remote label) — falls back to the id. */
  label: string;
  description: string;
  toolCount: number;
}

export interface McpRoster {
  tools: BuilderTool[];
  toolCount: number;
  overCap: boolean;
  servers: McpServerSummary[];
  /** Model-facing defs: full schemas under the cap, names-only over it. */
  defs: McpModelToolDef[];
  /** mcp_search_tools + mcp_describe_tool — present ONLY when overCap. */
  metaDefs: McpModelToolDef[];
  /** Serialized chars of defs + metaDefs — the meter's MCP-schema count (C10). */
  schemaChars: number;
}

// Always-on MCP discovery tools: even under the cap the model gets
// mcp_search_tools + mcp_describe_tool so it can find and learn tools that
// aren't shown in the prompt roster (small servers, servers added after the
// prompt was built, stale snapshot scenarios).
export const MCP_TOOL_CAP = 40;
export const MCP_DESC_MAX = 300;
export const MCP_ROSTER_DESC_MAX = 200;
export const MCP_NAMES_ONLY_DESC_MAX = 160;
export const MCP_SEARCH_TOOL = "mcp_search_tools";
export const MCP_DESCRIBE_TOOL = "mcp_describe_tool";

export const META_TOOL_DEFS: readonly McpModelToolDef[] = [
  {
    name: MCP_SEARCH_TOOL,
    description:
      "Search connected MCP tools by keyword over tool names, descriptions, and server ids. Returns matching mcp__<server>__<tool> names (up to 40). Use when a needed tool is not in your roster or you need its exact name.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to match against names, descriptions, and servers" },
      },
      required: ["query"],
    },
  },
  {
    name: MCP_DESCRIBE_TOOL,
    description:
      "Return the full input JSON schema and annotations for one MCP tool. Pass the exact mcp__<server>__<tool> name as returned by mcp_search_tools.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Full tool name, e.g. mcp__github__create_issue" },
      },
      required: ["tool"],
    },
  },
];

function normalizeDescription(desc: unknown, max: number): string {
  const s = typeof desc === "string" ? desc : "";
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/** JSON-Schema passthrough with a safe object default (same rule as the legacy executor). */
function toParameters(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function fingerprint(t: BuilderTool): string {
  try {
    return JSON.stringify([t.description, t.inputSchema, t.annotations ?? null]);
  } catch {
    return `${t.description}|unserializable`;
  }
}

/**
 * Build everything the model-facing surfaces need from one tool list.
 * serverMeta (optional): serverId → { label, description } for display.
 */
export function buildMcpRoster(
  tools: BuilderTool[],
  opts?: { serverMeta?: Record<string, { label?: string; description?: string }> }
): McpRoster {
  const meta = opts?.serverMeta ?? {};
  const seen = new Set<string>();
  const deduped: BuilderTool[] = [];
  for (const t of tools) {
    const full = mcpToolName(t.server, t.name);
    if (seen.has(full)) continue;
    seen.add(full);
    deduped.push(t);
  }

  const toolCount = deduped.length;
  const overCap = toolCount > MCP_TOOL_CAP;

  const defs: McpModelToolDef[] = deduped.map((t) =>
    overCap
      ? {
          name: mcpToolName(t.server, t.name),
          description: normalizeDescription(t.description, MCP_NAMES_ONLY_DESC_MAX),
          parameters: { type: "object", properties: {}, additionalProperties: true },
        }
      : {
          name: mcpToolName(t.server, t.name),
          description: normalizeDescription(t.description, MCP_DESC_MAX),
          parameters: toParameters(t.inputSchema),
        }
  );
  const metaDefs: McpModelToolDef[] = META_TOOL_DEFS.map((d) => ({ ...d }));

  const groups = new Map<string, McpServerSummary>();
  for (const t of deduped) {
    let g = groups.get(t.server);
    if (!g) {
      g = {
        name: t.server,
        label: meta[t.server]?.label ?? t.server,
        description: meta[t.server]?.description ?? "",
        toolCount: 0,
      };
      groups.set(t.server, g);
    }
    g.toolCount++;
  }

  const schemaChars =
    defs.reduce((s, d) => s + safeJsonLength(d), 0) + metaDefs.reduce((s, d) => s + safeJsonLength(d), 0);

  return {
    tools: deduped,
    toolCount,
    overCap,
    servers: [...groups.values()],
    defs,
    metaDefs,
    schemaChars,
  };
}

function safeJsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Wrap flat defs into the OpenAI chat-completions tools array shape. */
export function toOpenAiFunctions(defs: McpModelToolDef[]): Array<{ type: "function"; function: McpModelToolDef }> {
  return defs.map((d) => ({ type: "function" as const, function: d }));
}

/**
 * The "## MCP CONNECTOR TOOLS" roster block for a system prompt.
 * Under the cap: per-server lines with parameter names (the historical
 * format). Over the cap: every name listed (no drop) + meta-tool guidance.
 * Empty roster → "" (no prompt bloat).
 */
export function mcpPromptSection(roster: McpRoster): string {
  if (roster.toolCount === 0) return "";

  const byServer = new Map<string, BuilderTool[]>();
  for (const t of roster.tools) {
    const list = byServer.get(t.server) ?? [];
    list.push(t);
    byServer.set(t.server, list);
  }

  const lines: string[] = [];
  if (roster.overCap) {
    for (const s of roster.servers) {
      lines.push(`### Server "${s.label}"`);
      for (const t of byServer.get(s.name) ?? []) {
        lines.push(`- \`${mcpToolName(t.server, t.name)}\` — ${normalizeDescription(t.description, MCP_NAMES_ONLY_DESC_MAX)}`);
      }
    }
    return `## MCP CONNECTOR TOOLS — ${roster.toolCount} external tools (tool list is summarized; discover the rest with mcp_search_tools)

The connected MCP servers expose more tools than fit in full here. Every tool name is listed; schemas are names-only. Get exact parameters with \`${MCP_DESCRIBE_TOOL}\` (pass the full name) and find tools by keyword with \`${MCP_SEARCH_TOOL}\`. Call MCP tools with the built-in mcp_call tool: mcp_call({serverId: "<server id>", tool: "<tool name>", arguments: {…}}). The server id is the MCP server name from MCP connectors; the tool name is one of the names listed below. Results arrive as tool_result.

${lines.join("\n")}`;
  }

  for (const s of roster.servers) {
    lines.push(`### Server "${s.label}"`);
    for (const t of byServer.get(s.name) ?? []) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      const paramNames = props && typeof props === "object" ? Object.keys(props) : [];
      const params = paramNames.length ? `(${paramNames.join(", ")})` : "()";
      lines.push(`- \`${mcpToolName(t.server, t.name)}\`${params} — ${normalizeDescription(t.description, MCP_ROSTER_DESC_MAX)}`);
    }
  }

  return `## MCP CONNECTOR TOOLS — ${roster.toolCount} external tools

The user's connected MCP servers expose the tools below. If your function-calling list includes a server's per-tool names, call them directly like built-in tools; results arrive as tool_result. If your function-calling list does NOT include a server's per-tool names (lean/TPM-constrained providers), call them with the built-in tool mcp_call: mcp_call({serverId: "<server id>", tool: "<tool name>", arguments: {…}}). The server id is the MCP server name shown in MCP connectors (e.g. "supabase", "linear", "filesystem"); the tool name is the server's tool (e.g. "list_tables", "create_issue"). Results arrive as tool_result. Never invent server ids or tool names. Even tools not listed here are callable — discover them with mcp_search_tools({ query: "..." }) and read their exact parameters with mcp_describe_tool({ tool: "mcp__<server>__<tool>" }).

${lines.join("\n")}`;
}

/**
 * Execute the over-cap meta tools against the same tool list the roster was
 * built from (C10). Synchronous, pure — returns the tool_result body text.
 */
export function executeMcpMetaTool(
  name: string,
  args: Record<string, unknown>,
  tools: BuilderTool[]
): string {
  if (name === MCP_SEARCH_TOOL) {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) {
      return `error: ${MCP_SEARCH_TOOL} requires a non-empty "query".`;
    }
    const matches = tools.filter((t) => {
      const full = mcpToolName(t.server, t.name).toLowerCase();
      return (
        full.includes(query) ||
        t.server.toLowerCase().includes(query) ||
        (typeof t.description === "string" && t.description.toLowerCase().includes(query))
      );
    });
    if (matches.length === 0) {
      return `No MCP tools match "${query}". Use ${MCP_SEARCH_TOOL} with a broader keyword, or list: ${tools
        .slice(0, 20)
        .map((t) => mcpToolName(t.server, t.name))
        .join(", ")}`;
    }
    const shown = matches.slice(0, 40);
    const lines = shown.map(
      (t) => `- ${mcpToolName(t.server, t.name)} — ${normalizeDescription(t.description, MCP_NAMES_ONLY_DESC_MAX)}`
    );
    const more = matches.length > shown.length ? `\n…and ${matches.length - shown.length} more — refine the query.` : "";
    return `${matches.length} match(es) for "${query}":\n${lines.join("\n")}${more}\n\nUse ${MCP_DESCRIBE_TOOL} with a full name for its exact input schema.`;
  }

  if (name === MCP_DESCRIBE_TOOL) {
    const full = String(args.tool ?? "").trim();
    if (!full) {
      return `error: ${MCP_DESCRIBE_TOOL} requires "tool" (the full mcp__<server>__<tool> name).`;
    }
    const target = tools.find((t) => mcpToolName(t.server, t.name) === full);
    if (!target) {
      const near = tools
        .filter((t) => {
          const f = mcpToolName(t.server, t.name);
          return f.includes(full) || full.includes(f);
        })
        .slice(0, 5)
        .map((t) => mcpToolName(t.server, t.name));
      return `error: MCP tool "${full}" not found.${near.length ? ` Closest: ${near.join(", ")}` : ""}`;
    }
    try {
      return JSON.stringify(
        {
          tool: mcpToolName(target.server, target.name),
          server: target.server,
          description: target.description ?? "",
          parameters: toParameters(target.inputSchema),
          annotations: target.annotations ?? null,
        },
        null,
        2
      );
    } catch {
      return `error: schema for "${full}" is not serializable — call the tool with best-effort arguments.`;
    }
  }

  return `error: unknown meta tool "${name}" (expected ${MCP_SEARCH_TOOL} or ${MCP_DESCRIBE_TOOL}).`;
}
