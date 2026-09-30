// plugin-library-state.test.ts — Per-workspace bundle state (.orplex/bundles.json):
// defaults, install recording, toggles that never touch skill files, and
// end-to-end enforcement through the production loadToolHooks gate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isBundleEnabled,
  loadEnabledBundleRules,
  readBundleState,
  recordBundleInstall,
  setBundleEnabled,
} from "../plugin-library-state";
import { loadToolHooks, clearToolHookCache, parseToolHookConfig } from "../tool-hooks";
import { isBundleInstalled } from "../plugin-library";

function mkWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-bundle-state-"));
  fs.mkdirSync(path.join(ws, ".orplex", "skills", "verified-commits"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".orplex", "skills", "verified-commits", "SKILL.md"), "# test");
  return ws;
}

describe("bundle state file", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkWorkspace();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("installed with no state entry defaults to enabled", async () => {
    expect(await isBundleInstalled(ws, "verified-commits")).toBe(true);
    expect(await isBundleEnabled(ws, "verified-commits")).toBe(true);
    expect(await readBundleState(ws)).toEqual({});
  });

  it("recordBundleInstall snapshots rules and is idempotent", async () => {
    await recordBundleInstall(ws, "verified-commits");
    let state = await readBundleState(ws);
    expect(state["verified-commits"].enabled).toBe(true);
    expect(state["verified-commits"].rules?.deny.length).toBeGreaterThan(0);
    expect(state["verified-commits"].installedAt).toBeTruthy();

    await recordBundleInstall(ws, "verified-commits");
    state = await readBundleState(ws);
    expect(state["verified-commits"].enabled).toBe(true); // still enabled, refreshed
  });

  it("toggle flips the flag without touching the skill files", async () => {
    const skillFile = path.join(ws, ".orplex", "skills", "verified-commits", "SKILL.md");
    const before = fs.statSync(skillFile).mtimeMs;
    await recordBundleInstall(ws, "verified-commits");

    const off = await setBundleEnabled(ws, "verified-commits", false);
    expect(off?.enabled).toBe(false);
    expect(await isBundleEnabled(ws, "verified-commits")).toBe(false);
    expect(fs.existsSync(skillFile)).toBe(true); // files kept
    expect(fs.statSync(skillFile).mtimeMs).toBe(before);

    const on = await setBundleEnabled(ws, "verified-commits", true);
    expect(on?.enabled).toBe(true);
  });

  it("unknown slugs are rejected, rules survive a toggle", async () => {
    await recordBundleInstall(ws, "verified-commits");
    expect(await setBundleEnabled(ws, "not-a-bundle", false)).toBeNull();
    const state = await readBundleState(ws);
    expect(state["verified-commits"].rules?.deny).toContain("git\\s+push\\s+.*--force");
  });
});

describe("enforcement through loadToolHooks", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkWorkspace();
    clearToolHookCache();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    clearToolHookCache();
  });

  it("enabled installed bundle rules reach the enforced gate", async () => {
    await recordBundleInstall(ws, "verified-commits");
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(true);
    expect(evaluateDeny(hooks, "npm test")).toBe(false);
  });

  it("disabled bundle rules do NOT reach the gate", async () => {
    await recordBundleInstall(ws, "verified-commits");
    await setBundleEnabled(ws, "verified-commits", false);
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(false);
  });

  it("user config rules and bundle rules merge (both enforced)", async () => {
    fs.writeFileSync(
      path.join(ws, "orplex.config.json"),
      JSON.stringify({ toolHooks: { deny: ["drop\\s+table"], notify: [] } })
    );
    await recordBundleInstall(ws, "verified-commits");
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "run drop table users")).toBe(true); // user rule
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(true); // bundle rule
  });

  it("loadEnabledBundleRules reports active slugs and respects the off flag", async () => {
    await recordBundleInstall(ws, "verified-commits");
    let rules = await loadEnabledBundleRules(ws);
    expect(rules.active).toContain("verified-commits");

    await setBundleEnabled(ws, "verified-commits", false);
    rules = await loadEnabledBundleRules(ws);
    expect(rules.active).not.toContain("verified-commits");
    expect(rules.deny).toHaveLength(0);
  });

  it("a corrupt state file degrades to catalog-default rules (never throws)", async () => {
    fs.writeFileSync(path.join(ws, ".orplex", "bundles.json"), "{broken json");
    const rules = await loadEnabledBundleRules(ws);
    expect(rules.active).toContain("verified-commits"); // installed + no entry → enabled fallback
    expect(await loadToolHooks(ws).then((h) => h.deny.length)).toBeGreaterThan(0);
  });
});

function evaluateDeny(hooks: ReturnType<typeof parseToolHookConfig>, haystack: string): boolean {
  const { evaluateDenyRules } = require("../tool-hooks") as typeof import("../tool-hooks");
  return evaluateDenyRules(hooks, "run_command", { command: haystack }).blocked;
}
