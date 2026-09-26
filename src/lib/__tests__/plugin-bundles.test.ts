// Plugin bundle tests — discovery, parse, and install-merge semantics
// (user files always win on conflict).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverPlugins,
  installPlugin,
  parsePlugin,
} from "../plugin-bundles";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orplex-plugin-"));
}

function writeBundle(
  root: string,
  dirName: string,
  files: Record<string, string>
): string {
  const bundleDir = path.join(root, dirName);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return bundleDir;
}

describe("plugin bundles", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("discovers a bundle directory by manifest", async () => {
    const ws = tmpWorkspace();
    writeBundle(ws, "my-plugin", {
      "orplex-plugin.json": JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
    });

    const plugins = await discoverPlugins(ws);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("my-plugin");
    expect(plugins[0].manifest.version).toBe("1.0.0");
  });

  test("parses skills, hooks and mcp from a bundle", async () => {
    const ws = tmpWorkspace();
    writeBundle(ws, "full", {
      "orplex-plugin.json": JSON.stringify({ name: "full" }),
      "skills/deploy/SKILL.md": "---\ndescription: Deploy the app\n---\nRun the deploy script.",
      "hooks.json": JSON.stringify({ "post-run": [{ command: "echo done" }] }),
      "mcp.json": JSON.stringify({ fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } }),
    });

    const [plugin] = await discoverPlugins(ws);
    expect(plugin.skills).toEqual([
      { name: "deploy", body: expect.stringContaining("Deploy the app") },
    ]);
    expect(plugin.hooks).toEqual({ "post-run": [{ command: "echo done" }] });
    expect(plugin.mcp).toHaveProperty("fs");
    expect(plugin.warnings).toEqual([]);
  });

  test("install copies skills and merges hooks/mcp without clobbering user files", async () => {
    const ws = tmpWorkspace();
    const bundle = writeBundle(ws, "mega", {
      "orplex-plugin.json": JSON.stringify({ name: "mega" }),
      "skills/new-skill/SKILL.md": "Bundle skill body.",
      "skills/existing/SKILL.md": "Bundle version — must NOT win.",
      "hooks.json": JSON.stringify({
        "post-run": [{ command: "echo bundle-hook" }],
      }),
      "mcp.json": JSON.stringify({ fs: { command: "bundle-cmd" } }),
    });

    // Pre-existing user content that must win every conflict
    const orplex = path.join(ws, ".orplex");
    fs.mkdirSync(path.join(orplex, "skills", "existing"), { recursive: true });
    fs.writeFileSync(path.join(orplex, "skills", "existing", "SKILL.md"), "User version.", "utf8");
    fs.writeFileSync(
      path.join(orplex, "hooks.json"),
      JSON.stringify({ "post-run": [{ command: "echo user-hook" }] }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(orplex, "mcp.json"),
      JSON.stringify({ fs: { command: "user-cmd" } }),
      "utf8"
    );

    const plugin = await parsePlugin(bundle);
    const result = await installPlugin(plugin, ws);

    expect(result.installedSkills).toEqual(["new-skill"]);
    expect(result.mergedHooks).toBe(1);
    expect(result.mergedMcp).toBe(0); // existing server kept
    expect(result.warnings.some((w) => w.includes("existing"))).toBe(true);

    // User files intact, bundle content added alongside
    expect(
      fs.readFileSync(path.join(orplex, "skills", "existing", "SKILL.md"), "utf8")
    ).toBe("User version.");
    expect(
      fs.readFileSync(path.join(orplex, "skills", "new-skill", "SKILL.md"), "utf8")
    ).toBe("Bundle skill body.");
    const hooks = JSON.parse(fs.readFileSync(path.join(orplex, "hooks.json"), "utf8"));
    expect(hooks["post-run"]).toEqual([
      { command: "echo user-hook" },
      { command: "echo bundle-hook" },
    ]);
    const mcp = JSON.parse(fs.readFileSync(path.join(orplex, "mcp.json"), "utf8"));
    expect(mcp.fs.command).toBe("user-cmd");
  });

  test("install into a clean workspace creates .orplex from scratch", async () => {
    const ws = tmpWorkspace();
    const bundle = writeBundle(ws, "fresh", {
      "orplex-plugin.json": JSON.stringify({ name: "fresh" }),
      "skills/only/SKILL.md": "Only skill.",
      "mcp.json": JSON.stringify({ grep: { command: "rg" } }),
    });

    const plugin = await parsePlugin(bundle);
    const result = await installPlugin(plugin, ws);

    expect(result.installedSkills).toEqual(["only"]);
    expect(result.mergedMcp).toBe(1);
    expect(
      fs.existsSync(path.join(ws, ".orplex", "skills", "only", "SKILL.md"))
    ).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".orplex", "mcp.json"), "utf8"));
    expect(mcp.grep.command).toBe("rg");
  });

  test("unreadable manifest falls back to folder name with a warning", async () => {
    const ws = tmpWorkspace();
    writeBundle(ws, "broken-manifest", {
      "orplex-plugin.json": "{not json",
    });

    const [plugin] = await discoverPlugins(ws);
    expect(plugin.manifest.name).toBe("broken-manifest");
    expect(plugin.warnings.length).toBeGreaterThan(0);
  });
});
