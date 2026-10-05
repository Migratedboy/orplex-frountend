// mcp-gate.test.ts — ORPLEX_MCP lane resolution (Phase 8, conflict C8).
import { resolveMcpLane } from "../mcp/gate";

describe("resolveMcpLane", () => {
  it("defaults to sdk for unset/empty/odd values (fail-safe to the server lane)", () => {
    expect(resolveMcpLane(undefined)).toBe("sdk");
    expect(resolveMcpLane(null)).toBe("sdk");
    expect(resolveMcpLane("")).toBe("sdk");
    expect(resolveMcpLane("  ")).toBe("sdk");
    expect(resolveMcpLane("SDK")).toBe("sdk");
    expect(resolveMcpLane("true")).toBe("sdk");
    expect(resolveMcpLane("legac")).toBe("sdk");
    expect(resolveMcpLane("legacy2")).toBe("sdk");
  });

  it("selects legacy only for the exact value (case/whitespace-insensitive)", () => {
    expect(resolveMcpLane("legacy")).toBe("legacy");
    expect(resolveMcpLane("LEGACY")).toBe("legacy");
    expect(resolveMcpLane(" legacy ")).toBe("legacy");
  });
});
