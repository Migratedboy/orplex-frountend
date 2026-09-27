/**
 * proxy-guard.test.ts — SSRF defenses for the embedded-browser proxy.
 * Covers: IPv4/IPv6 non-public classification, hostname-shape checks
 * (decimal/hex IPv4 tricks), private/keyword hosts, DNS-level resolution
 * guards (rebinding-style hosts), redirect target parsing, and the strict
 * passthrough header allowlist (Set-Cookie must never survive).
 */
import {
  isNonPublicIp,
  staticUrlGuard,
  resolveTargetGuard,
  nextRedirectUrl,
  buildPassthroughHeaders,
} from "../proxy-guard";

describe("isNonPublicIp", () => {
  it("allows public IPv4", () => {
    expect(isNonPublicIp("1.2.3.4")).toBe(false);
    expect(isNonPublicIp("8.8.8.8")).toBe(false);
    expect(isNonPublicIp("172.15.255.255")).toBe(false); // just below RFC1918
    expect(isNonPublicIp("172.32.0.1")).toBe(false); // just above RFC1918
  });

  it("blocks loopback, unspecified, RFC1918, link-local, CGNAT", () => {
    expect(isNonPublicIp("127.0.0.1")).toBe(true);
    expect(isNonPublicIp("0.0.0.0")).toBe(true);
    expect(isNonPublicIp("10.1.2.3")).toBe(true);
    expect(isNonPublicIp("192.168.1.1")).toBe(true);
    expect(isNonPublicIp("172.16.0.1")).toBe(true);
    expect(isNonPublicIp("172.31.255.255")).toBe(true);
    expect(isNonPublicIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isNonPublicIp("100.100.1.1")).toBe(true);
    expect(isNonPublicIp("224.0.0.1")).toBe(true); // multicast
  });

  it("blocks IPv6 loopback, unique-local, link-local", () => {
    expect(isNonPublicIp("::1")).toBe(true);
    expect(isNonPublicIp("::")).toBe(true);
    expect(isNonPublicIp("fd00::1")).toBe(true);
    expect(isNonPublicIp("fe80::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 private addresses", () => {
    expect(isNonPublicIp("::ffff:127.0.0.1")).toBe(true);
    expect(isNonPublicIp("::ffff:10.0.0.5")).toBe(true);
  });

  it("treats unparseable input as non-public (fail closed)", () => {
    expect(isNonPublicIp("not-an-ip")).toBe(true);
    expect(isNonPublicIp("999.1.1.1")).toBe(true);
  });
});

describe("staticUrlGuard", () => {
  it("allows public web URLs", () => {
    expect(staticUrlGuard("https://example.com/page").ok).toBe(true);
    expect(staticUrlGuard("http://sub.domain.co.uk/").ok).toBe(true);
  });

  it("rejects non-web schemes", () => {
    expect(staticUrlGuard("file:///etc/passwd").ok).toBe(false);
    expect(staticUrlGuard("gopher://example.com").ok).toBe(false);
    expect(staticUrlGuard("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects private IP literals and localhost", () => {
    expect(staticUrlGuard("http://127.0.0.1:5433/").ok).toBe(false);
    expect(staticUrlGuard("http://10.0.0.5/").ok).toBe(false);
    expect(staticUrlGuard("http://192.168.1.1/admin").ok).toBe(false);
    expect(staticUrlGuard("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(staticUrlGuard("http://localhost:5000/api/x").ok).toBe(false);
  });

  it("rejects hostname shapes fetch would alias to private IPs", () => {
    // 2130706433 = 127.0.0.1 in decimal; 0x7f.0.0.1 mixes hex — neither is a
    // real domain or a dotted-quad, so the shape check rejects them.
    expect(staticUrlGuard("http://2130706433/").ok).toBe(false);
    expect(staticUrlGuard("http://0x7f.0.0.1/").ok).toBe(false);
    expect(staticUrlGuard("http://127.1/").ok).toBe(false);
  });

  it("rejects private-suffixed and metadata-style keyword hosts", () => {
    expect(staticUrlGuard("https://foo.localhost/").ok).toBe(false);
    expect(staticUrlGuard("https://box.internal/").ok).toBe(false);
    expect(staticUrlGuard("https://printer.local/").ok).toBe(false);
    expect(staticUrlGuard("https://host.lan/").ok).toBe(false);
    expect(staticUrlGuard("https://1.2.3.4.nip.io/").ok).toBe(true); // public DNS still allowed here; DNS guard catches the rest
  });
});

describe("resolveTargetGuard (DNS-level)", () => {
  const lookup = (map: Record<string, { address: string; family: number }[]>) => async (host: string) => {
    const hit = map[host];
    if (!hit) throw new Error("ENOTFOUND");
    return hit;
  };

  it("allows domains resolving only to public IPs", async () => {
    const l = lookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });
    const r = await resolveTargetGuard("https://example.com/", l);
    expect(r.ok).toBe(true);
  });

  it("blocks domains resolving to loopback (localtest.me style)", async () => {
    const l = lookup({ "localtest.me": [{ address: "127.0.0.1", family: 4 }] });
    const r = await resolveTargetGuard("http://localtest.me:5433/", l);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-public/);
  });

  it("blocks when ANY resolved address is private (multi-A rebinding)", async () => {
    const l = lookup({ "dual.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ] });
    const r = await resolveTargetGuard("https://dual.example.com/", l);
    expect(r.ok).toBe(false);
  });

  it("blocks DNS-failure and empty-resolution targets (fail closed)", async () => {
    const l = lookup({});
    expect((await resolveTargetGuard("https://nope.example.com/", l)).ok).toBe(false);
    const empty: never[] = [];
    const l2 = lookup({ "zero.example.com": empty });
    expect((await resolveTargetGuard("https://zero.example.com/", l2)).ok).toBe(false);
  });

  it("checks literal IPv4 without DNS", async () => {
    const never = async () => { throw new Error("DNS must not be consulted for literal IPs"); };
    expect((await resolveTargetGuard("http://192.168.0.1/", never)).ok).toBe(false);
    expect((await resolveTargetGuard("http://8.8.4.4/", never)).ok).toBe(true);
  });
});

describe("nextRedirectUrl", () => {
  it("resolves absolute and relative Location values", () => {
    expect(nextRedirectUrl("https://a.com/x", "https://b.com/y")).toBe("https://b.com/y");
    expect(nextRedirectUrl("https://a.com/x", "/rel")).toBe("https://a.com/rel");
  });

  it("returns null for missing or invalid targets", () => {
    expect(nextRedirectUrl("https://a.com/", null)).toBeNull();
    expect(nextRedirectUrl("https://a.com/", "https://exa mple.com/")).toBeNull(); // invalid URL
  });
});

describe("buildPassthroughHeaders", () => {
  it("keeps content-type/content-length only", () => {
    const h = new Headers({
      "Content-Type": "image/png",
      "Content-Length": "42",
    });
    const out = buildPassthroughHeaders(h);
    expect(out.get("content-type")).toBe("image/png");
    expect(out.get("content-length")).toBe("42");
    expect(out.has("set-cookie")).toBe(false);
  });

  it("drops upstream Set-Cookie (cookie tossing) and auth-adjacent headers", () => {
    const h = new Headers();
    h.append("Set-Cookie", "next-auth.session-token=stolen; Path=/");
    h.append("Set-Cookie", "tracker=1; Domain=.orplex.local");
    h.set("Content-Type", "text/css");
    h.set("Authorization", "Bearer x");
    h.set("WWW-Authenticate", "Basic");
    const out = buildPassthroughHeaders(h);
    expect(out.get("content-type")).toBe("text/css");
    expect(out.has("set-cookie")).toBe(false);
    expect(out.has("authorization")).toBe(false);
    expect(out.has("www-authenticate")).toBe(false);
  });
});
