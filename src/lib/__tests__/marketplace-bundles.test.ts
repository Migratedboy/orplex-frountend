// marketplace-bundles.test.ts — the seam between signed marketplace data and
// the SDK's hook gate.
//
// Two failure modes this is here to catch:
//  1. The app never registers a bundle provider, so installed library deny rules
//     silently stop being enforced (the SDK ships no bundles of its own).
//  2. Materialized bundles lose their hooks on the way through, which is exactly
//     what a publishing bug in the marketplace did once — the prose arrived, the
//     guardrails did not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURE = require("./fixtures/plugin-bundles.json") as {
  bundles: Array<import("@orplex/sdk/lib/plugin-library/types").BundleDef>;
};

jest.mock("@/lib/marketplace-client", () => ({
  getPluginBundles: jest.fn(async () => FIXTURE.bundles),
}));

import { getMaterializedBundles } from "../marketplace-bundles";
import { clearToolHookCache, evaluateDenyRules, loadToolHooks } from "../tool-hooks";

describe("marketplace bundles → hook gate", () => {
  it("materializes the published definitions, hooks included", async () => {
    const bundles = await getMaterializedBundles();
    expect(bundles).toHaveLength(FIXTURE.bundles.length);
    const verified = bundles.find((b) => b.slug === "verified-commits");
    const hooks = verified?.bundle.hooks as Record<string, string[]> | undefined;
    expect(hooks?.deny?.length).toBeGreaterThan(0);
    expect(verified?.bundle.skills.length).toBeGreaterThan(0);
  });

  it("registers the provider, so installed bundle rules reach loadToolHooks", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-mp-bundles-"));
    try {
      // Install = the skill file exists (content-based detection).
      const skillDir = path.join(ws, ".orplex", "skills", "verified-commits");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# x");

      await getMaterializedBundles(); // registers the provider on first use
      clearToolHookCache();

      const hooks = await loadToolHooks(ws);
      expect(hooks.deny.length).toBeGreaterThan(0);
      expect(evaluateDenyRules(hooks, "run_command", { command: "git push --force origin main" }).blocked).toBe(true);
      expect(evaluateDenyRules(hooks, "run_command", { command: "npm test" }).blocked).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      clearToolHookCache();
    }
  });

  it("memoizes the materialized list (one marketplace read per process)", async () => {
    const first = await getMaterializedBundles();
    const second = await getMaterializedBundles();
    expect(second).toBe(first);
  });
});
