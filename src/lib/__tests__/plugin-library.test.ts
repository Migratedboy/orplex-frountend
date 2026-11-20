// plugin-library.test.ts — the library MECHANICS, over injected bundle data.
//
// The 40 bundles themselves are marketplace data (published, signed and
// validated in orplex-marketplace, which also checks that their hook rules
// compile). What belongs here is the code that turns any bundle definition into
// something installable: materialization, listing, content-based install
// detection, and — because it is a security boundary — that materialized hook
// rules still enforce through the production parse/evaluate path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBundleInstalled, listLibrary, materializeBundle, materializeBundles } from "../plugin-library";
import type { BundleDef } from "../plugin-library/types";
import { evaluateDenyRules, parseToolHookConfig } from "../tool-hooks";

const DEFS: BundleDef[] = [
  {
    slug: "demo-rules",
    category: "quality",
    version: "1.0.0",
    description: "A bundle that carries deny/notify rules instead of prose only.",
    skills: [{ name: "demo-rules", body: "# Demo rules\n\n## Rules\n\n- Never rewrite history.\n- Always run the tests." }],
    hooks: { deny: ["git\\s+push\\s+.*--force"] },
  },
  {
    slug: "demo-plain",
    category: "devops",
    version: "2.1.0",
    description: "A bundle with no hook rules at all, to prove optionality.",
    skills: [{ name: "demo-plain", body: "# Demo plain\n\n## Shape\n\nWrite the thing, then check it." }],
  },
];

describe("library mechanics over injected bundle data", () => {
  const bundles = materializeBundles(DEFS);

  it("materializes every definition into an installable bundle", () => {
    expect(bundles).toHaveLength(DEFS.length);
    for (const b of bundles) {
      expect(b.slug).toMatch(/^[a-z0-9-]+$/);
      expect(b.bundle.manifest.name).toBe(b.slug);
      expect(b.bundle.skills.length).toBeGreaterThan(0);
    }
  });

  it("listLibrary reports hooks/mcp presence without touching the filesystem", () => {
    const rows = listLibrary(bundles);
    expect(rows).toHaveLength(2);
    const rules = rows.find((r) => r.slug === "demo-rules");
    expect(rules?.hasHooks).toBe(true);
    expect(rules?.skillCount).toBe(1);
    const plain = rows.find((r) => r.slug === "demo-plain");
    expect(plain?.hasHooks).toBe(false);
  });

  it("resolves known slugs and rejects unknown ones", () => {
    expect(materializeBundle(bundles, "demo-rules")?.manifest.name).toBe("demo-rules");
    expect(materializeBundle(bundles, "not-a-bundle")).toBeNull();
  });

  it("with no bundles (catalogue not loaded) nothing resolves", () => {
    expect(listLibrary([])).toEqual([]);
    expect(materializeBundle([], "demo-rules")).toBeNull();
  });
});

describe("installed detection (content-based)", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-plugin-lib-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const bundles = materializeBundles(DEFS);

  it("reports false before install, true once the first skill exists", async () => {
    expect(await isBundleInstalled(bundles, ws, "demo-rules")).toBe(false);
    const skillDir = path.join(ws, ".orplex", "skills", "demo-rules");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test");
    expect(await isBundleInstalled(bundles, ws, "demo-rules")).toBe(true);
  });

  it("unknown slugs are never 'installed'", async () => {
    expect(await isBundleInstalled(bundles, ws, "nope")).toBe(false);
  });
});

describe("materialized hook rules enforce through the production path", () => {
  it("compiles clean and blocks what it says it blocks", () => {
    const hooks = materializeBundle(materializeBundles(DEFS), "demo-rules")!.hooks;
    const compiled = parseToolHookConfig({ toolHooks: hooks });
    expect(compiled.errors).toEqual([]);
    expect(evaluateDenyRules(compiled, "run_command", { command: "git push --force origin main" }).blocked).toBe(true);
    expect(evaluateDenyRules(compiled, "run_command", { command: "git push origin feat/x" }).blocked).toBe(false);
  });

  it("a bundle with no hooks contributes no rules", () => {
    const hooks = materializeBundle(materializeBundles(DEFS), "demo-plain")!.hooks;
    expect(hooks).toBeUndefined();
  });
});
