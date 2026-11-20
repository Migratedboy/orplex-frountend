// plugin-library-state.test.ts — Per-workspace bundle state (.orplex/bundles.json):
// defaults, install recording, toggles that never touch skill files, and
// end-to-end enforcement through the production loadToolHooks gate.
//
// The bundle definitions are marketplace data now, so the suite supplies its own
// (a "verified-commits"-shaped bundle) through the same host hook the app uses:
// configureLibraryBundles(). If that wiring breaks, the enforcement tests below
// stop blocking force-push, which is exactly the failure worth catching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureLibraryBundles,
  isBundleEnabled,
  loadEnabledBundleRules,
  readBundleState,
  recordBundleInstall,
  setBundleEnabled,
} from "../plugin-library-state";
import { isBundleInstalled, materializeBundles } from "../plugin-library";
import type { BundleDef } from "../plugin-library/types";
import { loadToolHooks, clearToolHookCache, parseToolHookConfig } from "../tool-hooks";

const SLUG = "verified-commits";
const FORCE_PUSH_RULE = "git\\s+push\\s+.*--force";

const DEFS: BundleDef[] = [
  {
    slug: SLUG,
    category: "quality",
    version: "1.0.0",
    description: "The agent may only claim a task done when the machine agrees.",
    skills: [{ name: SLUG, body: "# Verified commits\n\n## Rules\n\n- Never rewrite history." }],
    hooks: { deny: [FORCE_PUSH_RULE] },
  },
];

const BUNDLES = materializeBundles(DEFS);

// Same contract the app declares at boot: the hook gate asks the host for the
// library bundles instead of the SDK shipping them.
configureLibraryBundles(() => BUNDLES);

function mkWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-bundle-state-"));
  fs.mkdirSync(path.join(ws, ".orplex", "skills", SLUG), { recursive: true });
  fs.writeFileSync(path.join(ws, ".orplex", "skills", SLUG, "SKILL.md"), "# test");
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
    expect(await isBundleInstalled(BUNDLES, ws, SLUG)).toBe(true);
    expect(await isBundleEnabled(ws, SLUG)).toBe(true);
    expect(await readBundleState(ws)).toEqual({});
  });

  it("recordBundleInstall snapshots rules and is idempotent", async () => {
    await recordBundleInstall(BUNDLES, ws, SLUG);
    let state = await readBundleState(ws);
    expect(state[SLUG].enabled).toBe(true);
    expect(state[SLUG].rules?.deny.length).toBeGreaterThan(0);
    expect(state[SLUG].installedAt).toBeTruthy();

    await recordBundleInstall(BUNDLES, ws, SLUG);
    state = await readBundleState(ws);
    expect(state[SLUG].enabled).toBe(true); // still enabled, refreshed
  });

  it("toggle flips the flag without touching the skill files", async () => {
    const skillFile = path.join(ws, ".orplex", "skills", SLUG, "SKILL.md");
    const before = fs.statSync(skillFile).mtimeMs;
    await recordBundleInstall(BUNDLES, ws, SLUG);

    const off = await setBundleEnabled(BUNDLES, ws, SLUG, false);
    expect(off?.enabled).toBe(false);
    expect(await isBundleEnabled(ws, SLUG)).toBe(false);
    expect(fs.existsSync(skillFile)).toBe(true); // files kept
    expect(fs.statSync(skillFile).mtimeMs).toBe(before);

    const on = await setBundleEnabled(BUNDLES, ws, SLUG, true);
    expect(on?.enabled).toBe(true);
  });

  it("unknown slugs are rejected, rules survive a toggle", async () => {
    await recordBundleInstall(BUNDLES, ws, SLUG);
    expect(await setBundleEnabled(BUNDLES, ws, "not-a-bundle", false)).toBeNull();
    const state = await readBundleState(ws);
    expect(state[SLUG].rules?.deny).toContain(FORCE_PUSH_RULE);
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
    await recordBundleInstall(BUNDLES, ws, SLUG);
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(true);
    expect(evaluateDeny(hooks, "npm test")).toBe(false);
  });

  it("disabled bundle rules do NOT reach the gate", async () => {
    await recordBundleInstall(BUNDLES, ws, SLUG);
    await setBundleEnabled(BUNDLES, ws, SLUG, false);
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(false);
  });

  it("user config rules and bundle rules merge (both enforced)", async () => {
    fs.writeFileSync(
      path.join(ws, "orplex.config.json"),
      JSON.stringify({ toolHooks: { deny: ["drop\\s+table"], notify: [] } })
    );
    await recordBundleInstall(BUNDLES, ws, SLUG);
    const hooks = await loadToolHooks(ws);
    expect(evaluateDeny(hooks, "run drop table users")).toBe(true); // user rule
    expect(evaluateDeny(hooks, "git push --force origin main")).toBe(true); // bundle rule
  });

  it("loadEnabledBundleRules reports active slugs and respects the off flag", async () => {
    await recordBundleInstall(BUNDLES, ws, SLUG);
    let rules = await loadEnabledBundleRules(ws);
    expect(rules.active).toContain(SLUG);

    await setBundleEnabled(BUNDLES, ws, SLUG, false);
    rules = await loadEnabledBundleRules(ws);
    expect(rules.active).not.toContain(SLUG);
    expect(rules.deny).toHaveLength(0);
  });

  it("a corrupt state file degrades to bundle-default rules (never throws)", async () => {
    fs.writeFileSync(path.join(ws, ".orplex", "bundles.json"), "{broken json");
    const rules = await loadEnabledBundleRules(ws);
    expect(rules.active).toContain(SLUG); // installed + no entry → enabled fallback
    expect(await loadToolHooks(ws).then((h) => h.deny.length)).toBeGreaterThan(0);
  });

  it("with no bundles configured the gate stays closed-but-empty", async () => {
    configureLibraryBundles(() => []);
    try {
      const rules = await loadEnabledBundleRules(ws);
      expect(rules.active).toEqual([]);
    } finally {
      configureLibraryBundles(() => BUNDLES);
    }
  });
});

function evaluateDeny(hooks: ReturnType<typeof parseToolHookConfig>, haystack: string): boolean {
  const { evaluateDenyRules } = require("../tool-hooks") as typeof import("../tool-hooks");
  return evaluateDenyRules(hooks, "run_command", { command: haystack }).blocked;
}
