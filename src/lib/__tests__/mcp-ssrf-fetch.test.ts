// mcp-ssrf-fetch.test.ts — C7 policy: what the MCP transports may fetch.
import { checkMcpUrl, createSsrfFetch, isLoopbackHost, McpSsrfError, ssrfFetch } from "../mcp/ssrf-fetch";

describe("checkMcpUrl — schemes", () => {
  it("accepts http and https only", () => {
    expect(checkMcpUrl("https://mcp.example.com/mcp").allowed).toBe(true);
    expect(checkMcpUrl("http://localhost:3001/mcp").allowed).toBe(true);
    for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi", "gopher://x/"]) {
      expect(checkMcpUrl(bad).allowed).toBe(false);
      expect(checkMcpUrl(bad).reason).toMatch(/scheme not allowed/);
    }
  });

  it("rejects unparseable URLs", () => {
    expect(checkMcpUrl("not a url").allowed).toBe(false);
    expect(checkMcpUrl("").allowed).toBe(false);
  });
});

describe("checkMcpUrl — loopback allowed (local dev MCP servers)", () => {
  it("allows localhost, 127.x and [::1] over http AND https", () => {
    for (const url of [
      "http://localhost:8931/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://127.0.0.53:4000/",
      "http://[::1]:5173/mcp",
      "https://localhost:8931/mcp",
    ]) {
      expect(checkMcpUrl(url)).toEqual({ allowed: true });
    }
  });

  it("isLoopbackHost classifies bracketed and dotted forms", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });
});

describe("checkMcpUrl — private / metadata hosts blocked", () => {
  it("blocks RFC1918, link-local metadata, CGNAT and ULA hosts even on https", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.10.20/x",
      "https://192.168.1.10/admin",
      "https://10.0.0.5:9000/api",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://100.64.0.1/",
      "https://[fd00::1]/",
    ]) {
      const v = checkMcpUrl(url);
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/private|link-local/);
    }
  });

  it("keeps public 172.15/172.32 boundary hosts allowed", () => {
    expect(checkMcpUrl("https://172.15.0.1/").allowed).toBe(true);
    expect(checkMcpUrl("https://172.32.0.1/").allowed).toBe(true);
  });
});

describe("checkMcpUrl — https required for public hosts", () => {
  it("blocks plain http to a public host (bearer tokens would leak)", () => {
    const v = checkMcpUrl("http://mcp.example.com/mcp");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/https required/);
  });

  it("allows public https", () => {
    expect(checkMcpUrl("https://mcp.linear.app/mcp").allowed).toBe(true);
  });
});

describe("createSsrfFetch / ssrfFetch", () => {
  it("forwards allowed URLs to the wrapped fetch", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      calls.push(String(url));
      return new Response("ok");
    };
    const guard = createSsrfFetch(fetchImpl);
    const res = await guard("https://mcp.example.com/mcp", { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://mcp.example.com/mcp"]);
  });

  it("throws McpSsrfError (typed, code mcp_ssrf_blocked) without touching the network", async () => {
    const calls: string[] = [];
    const guard = createSsrfFetch(async (url) => {
      calls.push(String(url));
      return new Response("ok");
    });
    await expect(guard("http://192.168.1.1/admin")).rejects.toBeInstanceOf(McpSsrfError);
    await expect(guard("file:///etc/passwd")).rejects.toMatchObject({ code: "mcp_ssrf_blocked" });
    expect(calls).toEqual([]);
  });

  it("accepts URL and Request inputs (original input forwarded)", async () => {
    const seen: string[] = [];
    const guard = createSsrfFetch(async (url: string | URL | Request) => {
      seen.push(url instanceof Request ? url.url : String(url));
      return new Response("ok");
    });
    await guard(new URL("https://example.com/mcp"));
    await guard(new Request("https://example.com/mcp"));
    expect(seen).toEqual(["https://example.com/mcp", "https://example.com/mcp"]);
  });

  it("the module-level ssrfFetch blocks private hosts", async () => {
    await expect(ssrfFetch("https://10.1.2.3/")).rejects.toBeInstanceOf(McpSsrfError);
  });
});
