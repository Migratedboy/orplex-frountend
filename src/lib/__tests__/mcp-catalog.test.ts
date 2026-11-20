// mcp-catalog.test.ts — the catalogue logic, over an injected catalogue.
//
// The 100 server entries are marketplace data now (signed, published in
// orplex-marketplace, validated there). What still needs unit coverage is the
// logic that operates on whatever catalogue the host supplies: schema
// validation, lookup, ranking, filtering and limits.
import {
  getMcpCatalogEntry,
  mcpCatalogEntrySchema,
  searchMcpCatalog,
  validateMcpCatalog,
  type McpCatalogEntry,
} from "@orplex/sdk/lib/mcp-catalog";
// Taxonomy labels stay in the app-side module; the entries do not.
import { MCP_CATEGORIES } from "../mcp-catalog";

const entry = (over: Partial<McpCatalogEntry> & { id: string }): McpCatalogEntry =>
  ({
    name: over.id,
    description: `${over.id} server for agents`, // schema needs >= 11 chars
    category: "devtools",
    version: "1.0.0",
    auth: "none",
    stdio: { command: "npx", args: ["-y", `${over.id}-mcp`], env: [] },
    ...over,
  }) as McpCatalogEntry;

const CATALOG: McpCatalogEntry[] = [
  entry({ id: "figma", name: "Figma", description: "Read and write design files", category: "design", auth: "oauth", popular: true }),
  entry({ id: "supabase", name: "Supabase", description: "Query tables and manage auth users", category: "database", auth: "token" }),
  entry({ id: "memory", name: "Memory", description: "Knowledge-graph memory for agents", category: "ai" }),
  entry({ id: "brave-search", name: "Brave Search", description: "Web results without tracking", category: "search" }),
  entry({ id: "airtable", name: "Airtable", description: "Create and update records", category: "productivity", auth: "oauth", popular: true }),
];

describe("mcp-catalog", () => {
  it("keeps the taxonomy labels the Connectors UI renders", () => {
    expect(MCP_CATALOGS_TAXONOMY()).toBe(true);
  });

  it("validates a well-formed catalogue and rejects a broken one", () => {
    expect(validateMcpCatalog(CATALOG).ok).toBe(true);

    const broken = [{ ...CATALOG[0], category: "not-a-category" }] as unknown as McpCatalogEntry[];
    const result = validateMcpCatalog(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("the schema rejects an entry with no transport at all", () => {
    const { stdio: _s, remote: _r, ...bare } = CATALOG[0] as unknown as Record<string, unknown>;
    void _s;
    void _r;
    const parsed = mcpCatalogEntrySchema.safeParse(bare);
    // An entry with neither stdio nor remote is not usable — it must not pass.
    expect(parsed.success).toBe(false);
  });

  it("looks entries up in the supplied catalogue only", () => {
    expect(getMcpCatalogEntry("figma", CATALOG)?.name).toBe("Figma");
    expect(getMcpCatalogEntry("not-there", CATALOG)).toBeNull();
    expect(getMcpCatalogEntry("figma", [])).toBeNull();
  });

  it("ranks exact name/id hits above description hits", () => {
    const hits = searchMcpCatalog("brave search", "all", 10, CATALOG);
    expect(hits[0].id).toBe("brave-search"); // hyphen normalised
    const desc = searchMcpCatalog("tracking", "all", 10, CATALOG);
    expect(desc[0].id).toBe("brave-search"); // only a description hit
  });

  it("is case-insensitive", () => {
    expect(searchMcpCatalog("SUPABASE", "all", 5, CATALOG)[0].id).toBe("supabase");
  });

  it("filters by category", () => {
    const design = searchMcpCatalog("", "design", 100, CATALOG);
    expect(design.length).toBeGreaterThan(0);
    expect(design.every((e) => e.category === "design")).toBe(true);
  });

  it("puts popular entries first on an empty query and respects the limit", () => {
    const all = searchMcpCatalog("", "all", 500, CATALOG);
    expect(all).toHaveLength(CATALOG.length);
    expect(all[0].popular).toBe(true);
    expect(searchMcpCatalog("", "all", 2, CATALOG)).toHaveLength(2);
  });

  it("returns nothing for garbage queries, and nothing without a catalogue", () => {
    expect(searchMcpCatalog("zzzznotapackage", "all", 10, CATALOG)).toEqual([]);
    expect(searchMcpCatalog("figma", "all", 10, [])).toEqual([]);
  });
});

/** The taxonomy is taxonomy, not catalogue content — it must survive the move. */
function MCP_CATALOGS_TAXONOMY(): boolean {
  return MCP_CATEGORIES.length >= 14 && MCP_CATEGORIES[0].key === "all";
}
