// Unit tests for the MCP catalog: size promise (100+), structural integrity,
// and search ranking behavior.
import { MCP_CATALOG, MCP_CATALOG_SIZE, MCP_CATEGORIES, getMcpCatalogEntry, searchMcpCatalog } from "../mcp-catalog";

describe("mcp-catalog", () => {
  it("ships 100+ servers", () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(100);
    expect(MCP_CATALOG_SIZE).toBe(MCP_CATALOG.length);
  });

  it("has unique ids and slugs", () => {
    const ids = new Set(MCP_CATALOG.map((e) => e.id));
    expect(ids.size).toBe(MCP_CATALOG.length);
  });

  it("every entry is well-formed (command, args, envSpec keys unique)", () => {
    for (const e of MCP_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(10);
      expect(typeof e.command).toBe("string");
      expect(Array.isArray(e.args)).toBe(true);
      expect(e.args.every((a) => typeof a === "string")).toBe(true);
      const keys = e.envSpec.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const spec of e.envSpec) {
        expect(spec.description.length).toBeGreaterThan(0);
      }
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
    expect(supabase.envSpec[0].secret).toBe(true);
    expect(supabase.envSpec[0].required).toBe(true);
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
