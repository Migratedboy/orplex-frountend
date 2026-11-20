// plugin-install-e2e.test.ts — the path a user actually takes: click Install on
// every bundle in the Plugins library, then let the agent use the result.
//
// This is the seam where three subsystems meet and where they used to break:
// installPlugin (fs writes) → loadUserSkills (roster the model sees) →
// loadToolHooks (the deny rules the server executor enforces). Unit tests on
// each half all passed while installed skills showed "(no description)", 8 of
// 40 were never rostered, and bundled hooks were written in a shape nothing read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin } from "../plugin-bundles";
import { materializeBundles } from "../plugin-library";
import type { BundleDef } from "../plugin-library/types";
import { configureLibraryBundles, recordBundleInstall } from "../plugin-library-state";
import { findSkill, loadUserSkills, MAX_ROSTER_CHARS, renderSkillRoster, skillBody } from "../user-skills";
import { clearToolHookCache, evaluateDenyRules, loadToolHooks } from "../tool-hooks";
import { parseUserHooks } from "../user-hooks";


// Fixture bundles. The real 40 live in orplex-marketplace (signed, and checked
// there that every hook rule compiles); this suite proves the SEAM — install →
// roster → enforced gate — with two bundles shaped like the real thing: one
// carrying deny rules, one plain.
const DEFS: BundleDef[] = [
  {
    slug: "verified-commits",
    category: "quality",
    version: "1.0.0",
    description: "The agent may only claim a task done when the machine agrees.",
    skills: [
      {
        name: "verified-commits",
        body: "# Verified commits\n\nTypecheck and tests must exit 0 before any done summary, and history rewriting is off-limits.\n\n## Rules\n\n- Run the suite before claiming success.\n- Never amend pushed history.",
      },
    ],
    hooks: { deny: ["git\\s+push\\s+.*--force"] },
  },
  {
    slug: "secret-hygiene",
    category: "security",
    version: "1.0.0",
    description: "Blocks credential-shaped writes before they land in a file.",
    skills: [
      {
        name: "secret-hygiene",
        body: "# Secret hygiene\n\nCredentials never get written to a workspace file or echoed into a log.\n\n## Rules\n\n- Refuse to write AWS keys, GitHub tokens or private key blocks.",
      },
    ],
    hooks: { deny: ["AKIA[0-9A-Z]{16}"] },
  },
];

const BUNDLES = materializeBundles(DEFS);
const SKILL_COUNT = BUNDLES.reduce((n, b) => n + b.bundle.skills.length, 0);

// Same contract the app registers at boot.
configureLibraryBundles(() => BUNDLES);

describe("install the whole library → what the agent sees and gets", () => {
  let ws: string;
  const home = () => path.join(ws, "no-home");

  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-plugin-e2e-"));
    for (const b of BUNDLES) {
      await installPlugin(b.bundle, ws);
      await recordBundleInstall(BUNDLES, ws, b.slug);
    }
    clearToolHookCache();
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("installs every library skill with a real name and description", async () => {
    const skills = await loadUserSkills(ws, home());
    expect(skills).toHaveLength(SKILL_COUNT);
    for (const s of skills) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.description).not.toBe("(no description)");
      expect(s.body.length).toBeGreaterThan(100);
    }
  });

  it("advertises every installed skill in the roster, inside the budget", async () => {
    const skills = await loadUserSkills(ws, home());
    const roster = renderSkillRoster(skills);
    expect(roster.length).toBeLessThanOrEqual(MAX_ROSTER_CHARS);
    for (const s of skills) expect(roster).toContain(`- ${s.name}:`);
  });

  it("resolves each advertised name to its body, as use_skill does", async () => {
    const skills = await loadUserSkills(ws, home());
    for (const s of skills) {
      expect(findSkill(skills, s.name.toUpperCase())).not.toBeNull();
      expect(skillBody(skills, s.name)).toMatch(/^# /);
    }
  });

  it("leaves hooks.json in the shape the runtime parses (no deny/notify junk)", async () => {
    const file = path.join(ws, ".orplex", "hooks.json");
    // No library bundle ships process hooks, so the file must not be created
    // at all — the old installer created it full of inert `deny`/`notify` keys.
    expect(fs.existsSync(file)).toBe(false);
    const parsed = parseUserHooks({});
    expect(parsed.hooks).toEqual([]);
  });

  it("enforces the installed bundles' deny rules through the real gate", async () => {
    const hooks = await loadToolHooks(ws);
    expect(hooks.errors).toEqual([]);
    expect(hooks.deny.length).toBeGreaterThanOrEqual(2);

    expect(
      evaluateDenyRules(hooks, "run_command", { command: "git push --force origin feat" }).blocked,
    ).toBe(true);
    expect(
      evaluateDenyRules(hooks, "write_file", {
        path: "a.ts",
        content: 'const k = "AKIAIOSFODNN7EXAMPLE";',
      }).blocked,
    ).toBe(true);
    expect(evaluateDenyRules(hooks, "write_file", { path: "a.ts", content: "export const x = 1;" }).blocked).toBe(
      false,
    );
  });

  it("re-installing the whole library changes nothing", async () => {
    for (const b of BUNDLES) {
      const again = await installPlugin(b.bundle, ws);
      expect(again.installedSkills).toEqual([]);
      expect(again.mergedHooks).toBe(0);
      expect(again.mergedMcp).toBe(0);
    }
    clearToolHookCache();
    const hooks = await loadToolHooks(ws);
    // Same rule count as a single install — no duplicates from the second pass.
    expect(hooks.deny.length).toBe(new Set(hooks.deny.map((r) => r.source)).size);
  });
});
