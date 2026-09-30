// five-plays.test.ts — Unit coverage for the five-plays build: BYOK factory,
// MCP tool naming, PR URL helpers, audit hash chain, and batch stagger math.

import { createProviderAdapter, describeProviderSelection, PROVIDER_KEY_ENV } from "../ai-providers";
import { mcpToolName, parseMcpToolName } from "../mcp-client";
import { originRepoSlug, compareUrl } from "../server-executor/worktree";
import { chainEvents, verifyBundle, clampArtifact, BUNDLE_FORMAT, type AuditBundle } from "../audit-bundle";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

// ── Phase 1: BYOK provider factory ──────────────────────────────────────────

describe("provider factory", () => {
  it("maps every provider to its key env var", () => {
    expect(PROVIDER_KEY_ENV.nvidia).toBe("NVIDIA_API_KEY");
    expect(PROVIDER_KEY_ENV.openrouter).toBe("OPENROUTER_API_KEY");
    expect(PROVIDER_KEY_ENV.groq).toBe("GROQ_API_KEY");
    expect(PROVIDER_KEY_ENV.custom).toBe("AI_API_KEY");
  });

  it("creates an openrouter adapter when selected", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-key";
    const a = createProviderAdapter();
    expect(a.name).toBe("openrouter");
  });

  it("creates a groq adapter when selected", () => {
    process.env.AI_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-key";
    expect(createProviderAdapter().name).toBe("groq");
  });

  it("custom adapter requires AI_BASE_URL", () => {
    process.env.AI_PROVIDER = "custom";
    delete process.env.AI_BASE_URL;
    expect(() => createProviderAdapter()).toThrow(/AI_BASE_URL/);
  });

  it("custom adapter uses the env triple", () => {
    process.env.AI_PROVIDER = "custom";
    process.env.AI_BASE_URL = "https://example.com/v1/chat/completions";
    process.env.AI_API_KEY = "k";
    process.env.AI_MODEL = "test-model";
    expect(createProviderAdapter().name).toBe("custom");
  });

  it("modelOverride overrides the env model", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "k";
    const sel = describeProviderSelection("my/custom-model");
    expect(sel.model).toBe("my/custom-model");
    expect(sel.budgetMode).toBe("byok");
  });

  it("defaults to nvidia with free-tier budget mode", () => {
    delete process.env.AI_PROVIDER;
    const sel = describeProviderSelection(null);
    expect(sel.provider).toBe("nvidia");
    expect(sel.budgetMode).toBe("free");
  });
});

// ── Phase 3: MCP naming ─────────────────────────────────────────────────────

describe("mcp tool naming", () => {
  it("builds and parses roster names", () => {
    const n = mcpToolName("github", "create_issue");
    expect(n).toBe("mcp__github__create_issue");
    expect(parseMcpToolName(n)).toEqual({ server: "github", tool: "create_issue" });
  });

  it("handles server names containing underscores", () => {
    const n = mcpToolName("my_server", "do_thing");
    expect(parseMcpToolName(n)).toEqual({ server: "my_server", tool: "do_thing" });
  });

  it("rejects non-MCP names", () => {
    expect(parseMcpToolName("write_file")).toBeNull();
    expect(parseMcpToolName("mcp__incomplete")).toBeNull();
  });
});

// ── Phase 2: PR link helpers ────────────────────────────────────────────────

describe("pr link helpers", () => {
  it("extracts the slug from https and ssh remotes", () => {
    expect(originRepoSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(originRepoSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(originRepoSlug("https://gitlab.com/acme/widgets.git")).toBeNull();
  });

  it("formats the compare URL with encoded branch", () => {
    const url = compareUrl("acme/widgets", "main", "orplex/run-abc123");
    expect(url).toContain("github.com/acme/widgets/compare/main...orplex%2Frun-abc123");
    expect(url).toContain("expand=1");
  });
});

// ── Phase 4: audit hash chain ───────────────────────────────────────────────

function makeBundle(events: Array<{ sequence: number; type: string; payload: unknown }>): AuditBundle {
  const { events: chained, chainHead } = chainEvents(
    events.map((e) => ({ ...e, createdAt: new Date(0).toISOString() })),
  );
  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date(0).toISOString(),
    run: { id: "r1", status: "completed" },
    events: chained,
    artifacts: [],
    tasks: [],
    approvals: [],
    chainHead,
    manifestMd: "",
  };
}

describe("audit bundle", () => {
  it("verifies an untampered bundle", () => {
    const b = makeBundle([
      { sequence: 0, type: "spawned", payload: { a: 1 } },
      { sequence: 1, type: "claimed", payload: { b: 2 } },
      { sequence: 2, type: "run-finished", payload: { c: 3 } },
    ]);
    expect(verifyBundle(b).valid).toBe(true);
  });

  it("rejects an edited payload", () => {
    const b = makeBundle([{ sequence: 0, type: "x", payload: { n: 1 } }]);
    b.events[0].payload = { n: 999 };
    expect(verifyBundle(b).valid).toBe(false);
  });

  it("rejects a removed event", () => {
    const b = makeBundle([
      { sequence: 0, type: "x", payload: {} },
      { sequence: 1, type: "y", payload: {} },
    ]);
    b.events = b.events.slice(1);
    expect(verifyBundle(b).valid).toBe(false);
  });

  it("rejects an unknown format", () => {
    const b = makeBundle([{ sequence: 0, type: "x", payload: {} }]);
    b.format = "other/v9";
    expect(verifyBundle(b).valid).toBe(false);
  });

  it("caps oversized artifact bodies", () => {
    const out = clampArtifact("x".repeat(150_000));
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("[truncated");
    expect(clampArtifact("small").truncated).toBe(false);
  });
});

// ── Phase 2: batch scheduling math (pure re-implementation of the route) ────

describe("batch stagger math", () => {
  it("staggers runs at the requested interval", () => {
    const first = Date.parse("2026-01-01T00:00:00Z");
    const stagger = 30 * 60_000;
    const times = [0, 1, 2].map((i) => new Date(first + i * stagger));
    expect(times[2].toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });
});
