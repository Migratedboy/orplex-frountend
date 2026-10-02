/**
 * Memory Sync Plugin — DISABLED
 *
 * Was: persists SONA learning-memory stats to localStorage on task complete.
 * Removed because its sole dependency (lib/sona.ts) was an aspirational
 * module with no other consumers — the stats existed only to be persisted.
 * Registered no hooks; kept as an inert stub so the initializer registry
 * and the plugins UI keep working.
 */
import type { PluginManifest } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "memory-sync",
  version: "1.1.0",
  description: "Disabled placeholder (SONA memory module removed)",
  author: "Orplex",
  hooks: [],
};

export async function activateMemorySync(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {}, async () => {});
}
