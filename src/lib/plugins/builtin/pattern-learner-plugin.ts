/**
 * Pattern Learner Plugin — Derives playbook entries from verified runs.
 *
 * Browser-safe by design: the plugin only REPORTS run facts to
 * POST /api/playbook/capture — the server derives and persists entries.
 * The client never decides what is worth remembering and never touches
 * the DB (same split as /api/agent/memory/capture).
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";
import { apiFetch } from "@/lib/api-base";

const manifest: PluginManifest = {
  name: "pattern-learner",
  version: "1.0.0",
  description: "Derives playbook entries from verified runs — confidence rises with evidence",
  author: "Orplex",
  hooks: ["onTaskComplete"],
};

const hooks: PluginHook[] = [{
  name: "onTaskComplete",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    try {
      const task = (ctx.task as string) || "";
      const files = (ctx.files as Record<string, string>) || {};
      if (!task || Object.keys(files).length === 0) return { continue: true };
      const res = await apiFetch("/api/playbook/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          files,
          lanes: ctx.lanes ?? {},
          finalStatus: ctx.finalStatus ?? "done",
        }),
      });
      const data = (await res.json().catch(() => null)) as { stored?: number } | null;
      if (data && typeof data.stored === "number" && data.stored > 0) {
        return { continue: true, message: `PatternLearner: merged ${data.stored} entr${data.stored === 1 ? "y" : "ies"}` };
      }
    } catch {
      // Never let learning break a task completion.
    }
    return { continue: true };
  },
}];

export async function activatePatternLearner(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "pattern-learner", handler: hook.handler }); }
  }, async () => {});
}
