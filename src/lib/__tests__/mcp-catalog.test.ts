// Unit tests for the MCP catalog: size promise (100+), structural integrity,
// Zod schema validation, auth/stdio shape, and search ranking behavior.
import {
  MCP_CATALOG,
  MCP_CATALOG_SIZE,
  MCP_CATEGORIES,
  getMcpCatalogEntry,
  mcpCatalogEntrySchema,
  searchMcpCatalog,
  validateMcpCatalog,
} from "../mcp-catalog";

describe("mcp-catalog", () => {
  it("ships 100+ servers", () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(95);
    expect(MCP_CATALOG_SIZE).toBe(MCP_CATALOG.length);
  });

  it("has unique ids and slugs", () => {
    const ids = new Set(MCP_CATALOG.map((e) => e.id));
    expect(ids.size).toBe(MCP_CATALOG.length);
  });

  it("every entry is well-formed (stdio command/args, unique env names, labels)", () => {
    for (const e of MCP_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(10);
      expect(e.stdio).toBeDefined();
      expect(typeof e.stdio!.command).toBe("string");
      expect(e.stdio!.command.length).toBeGreaterThan(0);
      expect(Array.isArray(e.stdio!.args)).toBe(true);
      expect(e.stdio!.args.every((a) => typeof a === "string")).toBe(true);
      const names = e.stdio!.env.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
      for (const spec of e.stdio!.env) {
        expect(spec.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(spec.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("passes the Zod catalog schema (load-time validation)", () => {
    const result = validateMcpCatalog();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    for (const e of MCP_CATALOG) {
      const parsed = mcpCatalogEntrySchema.safeParse(e);
      expect(parsed.success).toBe(true);
    }
  });

  it("derives a consistent auth type for every entry", () => {
    for (const e of MCP_CATALOG) {
      expect(["oauth", "token", "none"]).toContain(e.auth);
      if (e.auth === "oauth") expect(e.oauth).toBeDefined();
      if (e.auth === "token") {
        expect((e.stdio?.env ?? []).some((s) => s.secret)).toBe(true);
      }
      if (e.oauth) expect(e.auth).toBe("oauth");
      if (e.docsUrl) expect(e.docsUrl.startsWith("https://")).toBe(true);
    }
    // Every entry with a secret env var must not claim "none".
    for (const e of MCP_CATALOG) {
      const hasSecret = (e.stdio?.env ?? []).some((s) => s.secret);
      if (hasSecret) expect(e.auth).not.toBe("none");
    }
  });

  it("covers the marquee integrations", () => {
    for (const id of ["supabase", "firebase", "vercel", "figma", "github", "notion", "stripe", "postgres"]) {
      expect(getMcpCatalogEntry(id)).not.toBeNull();
    }
    expect(getMcpCatalogEntry("does-not-exist")).toBeNull();
  });

  it("marks popular entries and secret env fields", () => {
    expect(MCP_CATALOG.filter((e) => e.popular).length).toBeGreaterThanOrEqual(15);
    const supabase = getMcpCatalogEntry("supabase")!;
    expect(supabase.stdio!.env[0].secret).toBe(true);
    expect(supabase.stdio!.env[0].required).toBe(true);
    expect(supabase.auth).toBe("oauth");
  });

  it("exposes display categories that match the catalog", () => {
    const keys = new Set(MCP_CATEGORIES.map((c) => c.key));
    expect(keys.has("all")).toBe(true);
    for (const e of MCP_CATALOG) {
      expect(keys.has(e.category)).toBe(true);
    }
  });
});

describe("searchMcpCatalog", () => {
  it("returns everything (popular first) on empty query", () => {
    const all = searchMcpCatalog("", "all", 500);
    expect(all.length).toBe(MCP_CATALOG.length);
    expect(all[0].popular).toBe(true);
  });

  it("matches by name, id, and description", () => {
    const byName = searchMcpCatalog("figma", "all", 100);
    expect(byName[0].id).toBe("figma");
    const byDesc = searchMcpCatalog("knowledge graph", "all", 100);
    expect(byDesc.some((e) => e.id === "memory")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(searchMcpCatalog("SUPABASE", "all", 5)[0].id).toBe("supabase");
  });

  it("filters by category", () => {
    const design = searchMcpCatalog("", "design", 100);
    expect(design.length).toBeGreaterThan(0);
    expect(design.every((e) => e.category === "design")).toBe(true);
  });

  it("respects the limit", () => {
    expect(searchMcpCatalog("", "all", 7).length).toBe(7);
  });

  it("returns nothing for garbage queries", () => {
    expect(searchMcpCatalog("zzzznotapackage", "all", 10)).toEqual([]);
  });
});
