/**
 * mcp-lane.ts — the MCP dispatch lanes, extracted verbatim from
 * native-tools.ts (Operation Modularity).
 *
 * Owns: the Phase 8 lane gate (ORPLEX_MCP, default "sdk"), the SDK-lane
 * roster snapshot cache, the C6 risk assessment, and the three dispatch
 * branches (mcp__<server>__<tool>, mcp_call, mcp_search_tools /
 * mcp_describe_tool). tryMcpDispatch returns null when the call is not an
 * MCP tool so the main dispatcher falls through to the built-ins.
 *
 * The lane/roster caches were module-level state in native-tools.ts and stay
 * module-level here — one instance per bundle, exactly as before.
 */
import { apiFetch } from "@/lib/api-base";
import { classifyRisk } from "../risk-classifier";
import { requestApproval } from "../approval-store";
import { emitActivity } from "../agent-events";
import type { ToolCall } from "../stream-reader";
import type { ToolContext, DispatchOutcome } from "./native-tools";

// === Phase 8 lane gate (ORPLEX_MCP, default "sdk") ===========================
// Server env isn't visible here, so ask GET /api/agent/mcp once per session
// (static until restart). A fetch failure falls back to "sdk" — the
// server-side lane, whose dispatch errors surface honestly in the result.
type McpLane = "sdk" | "legacy";
let lanePromise: Promise<McpLane> | null = null;
function getMcpLane(): Promise<McpLane> {
  if (!lanePromise) {
    lanePromise = (async (): Promise<McpLane> => {
      try {
        const r = await apiFetch("/api/agent/mcp");
        const j = (await r.json()) as { success?: boolean; lane?: string };
        if (j?.success && (j.lane === "sdk" || j.lane === "legacy")) return j.lane;
      } catch {}
      return "sdk";
    })();
  }
  return lanePromise;
}

// SDK-lane roster (snapshot + toggles) for the C6 risk gate and the meta
// tools — fetched on demand, cached for a minute so a long run doesn't
// refetch per call.
interface SdkRosterTool {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: import("../mcp/registry").McpToolAnnotations;
}
type RawSdkRosterTool = Omit<SdkRosterTool, "description"> & { description?: string | null; annotations?: import("../mcp/registry").McpToolAnnotations | null };
let sdkRoster: { at: number; tools: SdkRosterTool[]; serverPrefs: Record<string, { autoApproveReadOnly: boolean }> } | null = null;
const SDK_ROSTER_TTL_MS = 60_000;
async function getSdkRoster(): Promise<{ tools: SdkRosterTool[]; serverPrefs: Record<string, { autoApproveReadOnly: boolean }> }> {
  // Reuse a fresh successful cache — avoids a per-call refetch during long runs.
  if (sdkRoster && Date.now() - sdkRoster.at < SDK_ROSTER_TTL_MS) {
    return { tools: sdkRoster.tools, serverPrefs: sdkRoster.serverPrefs };
  }

  let fetched: { tools: SdkRosterTool[]; serverPrefs: Record<string, { autoApproveReadOnly: boolean }> } | null = null;
  try {
    const r = await apiFetch("/api/agent/mcp/tools");
    const j = (await r.json()) as { success?: boolean; tools?: RawSdkRosterTool[]; serverPrefs?: Record<string, { autoApproveReadOnly: boolean }> };
    if (j?.success && Array.isArray(j.tools)) {
      const tools: SdkRosterTool[] = j.tools.map((t) => ({
        ...t,
        description: t.description ?? "",
        annotations: t.annotations ?? undefined,
      }));
      fetched = { tools, serverPrefs: j.serverPrefs ?? {} };
    }
  } catch {
    // Network/timeout — leave fetched null.
  }

  // A successful fetch always wins (and is cached).
  if (fetched) {
    sdkRoster = { at: Date.now(), ...fetched };
    return fetched;
  }

  // Fetch failed or returned no tools. Keep a still-fresh successful cache if we
  // have one — the model's MCP section is built server-side from the snapshot
  // (a separate path), so a transient client-side fetch failure must not mask tools
  // the model can already see and call. Only fall through to empty when there's no
  // usable cache at all.
  if (sdkRoster && Date.now() - sdkRoster.at < SDK_ROSTER_TTL_MS) {
    return { tools: sdkRoster.tools, serverPrefs: sdkRoster.serverPrefs };
  }
  return { tools: [], serverPrefs: {} };
}

/** C6 in the SDK lane: snapshot ToolAnnotations + Prisma toggle → classifyRisk (fail closed). */
async function assessSdkMcpRisk(fullName: string): Promise<{ level: "low" | "medium" | "high"; reason: string; autoApprovable: boolean }> {
  const { mcpRiskHintFrom } = await import("../risk-classifier");
  const { parseMcpToolName } = await import("../mcp/registry");
  const parsed = parseMcpToolName(fullName);
  if (!parsed) return classifyRisk(fullName, {});
  const { tools, serverPrefs } = await getSdkRoster();
  const tool = tools.find((t) => t.server === parsed.serverId && t.name === parsed.toolName);
  const autoApprove = serverPrefs[parsed.serverId]?.autoApproveReadOnly ?? false;
  return classifyRisk(fullName, {}, mcpRiskHintFrom(tool?.annotations, autoApprove));
}

/**
 * Try the MCP lanes first. Returns null when the call is not an MCP tool —
 * the dispatcher then falls through to the built-in branches.
 */
export async function tryMcpDispatch(
  call: ToolCall,
  ctx: ToolContext
): Promise<DispatchOutcome | null> {
  let toolResults = "";
  const result = (xml: string) => {
    toolResults += xml;
  };

  // ── MCP connector tools (mcp__<server>__<tool>) ─────────────────────
  // OAuth-authenticated remote servers connected in MCP connectors. Checked
  // FIRST so their names never collide with built-ins. Risk-tiered approval
  // runs BEFORE dispatch (C6): unknown third-party tools default to medium,
  // only server-declared read-only + the user's per-server toggle go silent.
  // The lane decides where the call executes (Phase 8): legacy = the
  // in-process renderer client; sdk = POST /api/agent/mcp/call → hub.
  if (call.name.startsWith("mcp__")) {
    const lane = await getMcpLane();
    let mcpRisk: { level: "low" | "medium" | "high"; reason: string; autoApprovable: boolean };
    if (lane === "legacy") {
      const { assessMcpToolRisk } = await import("../mcp/risk-hint");
      mcpRisk = assessMcpToolRisk(call.name);
    } else {
      mcpRisk = await assessSdkMcpRisk(call.name);
    }
    if (!mcpRisk.autoApprovable) {
      if (mcpRisk.level === "high") {
        emitActivity({ type: "tool", message: `High-risk MCP tool requires approval: ${call.name}`, agent: "coder" });
      }
      ctx.setStatus("awaiting_approval", `Waiting for approval: ${call.name}`);
      ctx.appendDisplay(`${call.name} — awaiting approval\n`);
      ctx.syncDisplay();
      const approved = await requestApproval(
        "mcp_tool",
        `MCP tool ${call.name} — ${mcpRisk.reason}`,
        { tool: call.name },
        undefined,
        mcpRisk.level
      , ctx.abortSignal);
      if (!approved) {
        ctx.stats.rejectedAction();
        result(`<tool_result name="${call.name}">rejected by user</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Rejected: ${call.name}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
    }
    const { dispatchMcpToolCall, dispatchMcpToolCallSdk } = await import("../mcp/dispatch");
    const impl = lane === "legacy" ? dispatchMcpToolCall : dispatchMcpToolCallSdk;
    return impl(call as { name: string } & Record<string, unknown>, {
      setStatus: ctx.setStatus,
      appendDisplay: ctx.appendDisplay,
      syncDisplay: ctx.syncDisplay,
    });
  }

  // ── Universal MCP caller (mcp_call) — available on EVERY provider. ───────
  // A lean/unknown provider (nvidia, any BYOK endpoint) doesn't get the
  // server's per-tool MCP definitions in its function-calling array, so the
  // model can't emit a direct mcp__ call — but it CAN emit mcp_call with the
  // server id + tool name + args it learned from the prompt section /
  // mcp_search_tools. This dispatches through the SAME risk gate + lane as a
  // direct mcp__ call, so MCP works on every provider, not just full-set ones.
  if (call.name === "mcp_call") {
    const serverId = (call as unknown as Record<string, unknown>).serverId as string | undefined;
    const tool = (call as unknown as Record<string, unknown>).tool as string | undefined;
    const args = (call as unknown as Record<string, unknown>).arguments as Record<string, unknown> ?? {};
    if (!serverId || !tool) {
      result(`<tool_result name="mcp_call">\nerror: mcp_call requires serverId and tool (e.g. mcp_call({serverId: "supabase", tool: "list_tables", arguments: {}}). Use mcp_search_tools to list connected servers and their tools.\n</tool_result>\n`);
      return { resultXml: toolResults, blocked: false };
    }
    const mcpName = `mcp__${serverId}__${tool}`;
    const lane = await getMcpLane();
    let mcpRisk: { level: "low" | "medium" | "high"; reason: string; autoApprovable: boolean };
    if (lane === "legacy") {
      const { assessMcpToolRisk } = await import("../mcp/risk-hint");
      mcpRisk = assessMcpToolRisk(mcpName);
    } else {
      mcpRisk = await assessSdkMcpRisk(mcpName);
    }
    if (!mcpRisk.autoApprovable) {
      if (mcpRisk.level === "high") {
        emitActivity({ type: "tool", message: `High-risk MCP tool requires approval: ${mcpName}`, agent: "coder" });
      }
      ctx.setStatus("awaiting_approval", `Waiting for approval: ${mcpName}`);
      ctx.appendDisplay(`${mcpName} — awaiting approval\n`);
      ctx.syncDisplay();
      const approved = await requestApproval(
        "mcp_tool",
        `MCP tool ${mcpName} — ${mcpRisk.reason}`,
        { tool: mcpName },
        undefined,
        mcpRisk.level
      , ctx.abortSignal);
      if (!approved) {
        ctx.stats.rejectedAction();
        result(`<tool_result name="mcp_call">rejected by user</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Rejected: ${mcpName}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
    }
    const { dispatchMcpToolCall, dispatchMcpToolCallSdk } = await import("../mcp/dispatch");
    const impl = lane === "legacy" ? dispatchMcpToolCall : dispatchMcpToolCallSdk;
    // NOTE: a model-supplied parameter literally named "name" must never
    // clobber the mcp__<server>__<tool> dispatch target (the server lane
    // already strips it the same way).
    const restArgs = { ...args };
    delete restArgs.name;
    return impl(
      { ...restArgs, name: mcpName } as { name: string } & Record<string, unknown>,
      {
        setStatus: ctx.setStatus,
        appendDisplay: ctx.appendDisplay,
        syncDisplay: ctx.syncDisplay,
      }
    );
  }

  // ── over-cap MCP meta tools (C10) ─────────────────────────────────────
  // Read-only discovery (no approval): search/describe run against the same
  // roster the prompt section was built from — localStorage in the legacy
  // lane, the Phase 5 snapshot (GET /api/agent/mcp/tools) in the sdk lane.
  if (call.name === "mcp_search_tools" || call.name === "mcp_describe_tool") {
    const { executeMcpMetaTool } = await import("../mcp/tool-builder");
    const lane = await getMcpLane();
    let tools: SdkRosterTool[];
    if (lane === "legacy") {
      const { loadRemotes } = await import("../mcp/registry");
      tools = loadRemotes().flatMap((r) =>
        (r.tools ?? []).map((t) => ({
          server: r.id,
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        }))
      );
    } else {
      tools = (await getSdkRoster()).tools;
    }
    ctx.setStatus("tool_executing", `${call.name}…`);
    const out = executeMcpMetaTool(call.name, call as unknown as Record<string, unknown>, tools);
    ctx.appendDisplay(`[OK] ${call.name}\n`);
    ctx.syncDisplay();
    result(`<tool_result name="${call.name}">\n${out}\n</tool_result>\n`);
    return { resultXml: toolResults, blocked: false };
  }

  return null;
}
