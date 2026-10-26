// loopback.test.ts — how the app addresses its own server.
//
// Regression guard for "Server failed to start": the server binds 127.0.0.1
// (IPv4) while "localhost" resolves to ::1 (IPv6) first on Windows, so the
// readiness probe never reached the server even though it was running.

import { LOOPBACK_HOST, loopbackProbeUrls, loopbackUrl } from "../loopback";

describe("loopback addressing", () => {
  it("uses the address the server is actually bound to", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(loopbackUrl(5000)).toBe("http://127.0.0.1:5000");
    expect(loopbackUrl(5010)).toBe("http://127.0.0.1:5010");
  });

  it("probes the bound address FIRST and keeps localhost as a fallback", () => {
    const urls = loopbackProbeUrls(5000);
    expect(urls[0]).toBe("http://127.0.0.1:5000");
    expect(urls).toContain("http://localhost:5000");
  });

  it("never probes localhost before the bound address", () => {
    for (const port of [5000, 5010]) {
      const urls = loopbackProbeUrls(port);
      expect(urls.indexOf(loopbackUrl(port))).toBeLessThan(urls.indexOf(`http://localhost:${port}`));
    }
  });
});
