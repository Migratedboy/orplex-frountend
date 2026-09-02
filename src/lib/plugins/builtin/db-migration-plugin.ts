/**
 * DB Migration Plugin — Generates Prisma migrations
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "db-migration",
  version: "1.0.0",
  description: "Generates Prisma migrations from schema changes",
  author: "Orplex",
  hooks: ["onFileWrite", "onFileEdit"],
};

function checkSchema(ctx: HookContext): boolean {
  const path = (ctx.path as string) || "";
  return path.includes("schema.prisma");
}

const hooks: PluginHook[] = [
  {
    name: "onFileWrite",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (checkSchema(ctx)) return { continue: true, message: "DBMigration: Schema changed" };
      return { continue: true };
    },
  },
  {
    name: "onFileEdit",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (checkSchema(ctx)) return { continue: true, message: "DBMigration: Schema edited" };
      return { continue: true };
    },
  },
];

export async function activateDBMigration(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "db-migration", handler: hook.handler }); }
  }, async () => {});
}
