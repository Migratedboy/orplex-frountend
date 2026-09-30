/**
 * browser-url-policy.test.ts — The agent's browser must never become a LAN
 * or cloud-metadata prober. Verifies the default private-host guard, explicit
 * allow/denylists, precedence, and edge cases of checkUrlPolicy.
 */
import { checkUrlPolicy } from "../browser-verification";

describe("checkUrlPolicy — default private-host guard", () => {
  it("allows the dev server on loopback (any port)", () => {
    expect(checkUrlPolicy("http://localhost:5000/").allowed).toBe(true);
    expect(checkUrlPolicy("http://127.0.0.1:3000/dashboard").allowed).toBe(true);
    expect(checkUrlPolicy("http://localhost:8080").allowed).toBe(true);
  });

  it("blocks cloud metadata and link-local targets", () => {
    expect(checkUrlPolicy("http://169.254.169.254/latest/meta-data/").allowed).toBe(false);
    expect(checkUrlPolicy("http://169.254.10.20/").allowed).toBe(false);
  });

  it("blocks RFC1918 / CGNAT / IPv6 private targets", () => {
    expect(checkUrlPolicy("http://192.168.1.1/admin").allowed).toBe(false);
    expect(checkUrlPolicy("http://10.0.0.5:9000/").allowed).toBe(false);
    expect(checkUrlPolicy("http://172.16.0.1/").allowed).toBe(false);
    expect(checkUrlPolicy("http://172.31.255.255/").allowed).toBe(false);
    expect(checkUrlPolicy("http://100.100.1.1/").allowed).toBe(false);
    expect(checkUrlPolicy("http://[::1]:5000/").allowed).toBe(false);
    expect(checkUrlPolicy("http://[fd00::1]/").allowed).toBe(false);
  });

  it("allows public hosts and does not over-match RFC1918 ranges", () => {
    expect(checkUrlPolicy("https://example.com/").allowed).toBe(true);
    // 172.x outside 172.16-31 is public
    expect(checkUrlPolicy("http://172.15.0.1/").allowed).toBe(true);
    expect(checkUrlPolicy("http://172.32.0.1/").allowed).toBe(true);
    // 100.x outside 100.64-127 is public
    expect(checkUrlPolicy("http://100.1.2.3/").allowed).toBe(true);
    expect(checkUrlPolicy("http://100.128.0.1/").allowed).toBe(true);
  });
});

describe("checkUrlPolicy — explicit lists and precedence", () => {
  it("deny wins over allow", () => {
    const policy = { allow: ["example.com"], deny: ["bad.example.com"] };
    expect(checkUrlPolicy("https://bad.example.com/x", policy).allowed).toBe(false);
    expect(checkUrlPolicy("https://example.com/x", policy).allowed).toBe(true);
  });

  it("allow overrides the default private-host guard", () => {
    // E.g. user explicitly authorizes a second local service
    const policy = { allow: ["192.168.1.50"] };
    expect(checkUrlPolicy("http://192.168.1.50:8080/api", policy).allowed).toBe(true);
    // ...but only that host
    expect(checkUrlPolicy("http://192.168.1.51:8080/api", policy).allowed).toBe(false);
  });

  it("matches subdomains of list entries but not lookalikes", () => {
    // Use deny so the match semantics are observable (public non-matches
    // fall through to the default-allow and would be true regardless).
    const policy = { deny: ["example.com"] };
    expect(checkUrlPolicy("https://app.example.com/", policy).allowed).toBe(false);
    expect(checkUrlPolicy("https://notexample.com/", policy).allowed).toBe(true);
  });

  it("deny by URL prefix works for full paths", () => {
    const policy = { deny: ["https://example.com/admin"] };
    expect(checkUrlPolicy("https://example.com/admin/users", policy).allowed).toBe(false);
    expect(checkUrlPolicy("https://example.com/public", policy).allowed).toBe(true);
  });
});

describe("checkUrlPolicy — edge cases", () => {
  it("rejects unparseable URLs", () => {
    expect(checkUrlPolicy("not a url").allowed).toBe(false);
  });

  it("treats loopback by name and IP identically", () => {
    expect(checkUrlPolicy("http://localhost:5000", {}).allowed).toBe(true);
    expect(checkUrlPolicy("http://127.0.0.1:5000", {}).allowed).toBe(true);
  });
});
