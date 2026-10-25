import crypto from "node:crypto";

describe("desktop-auth", () => {
  const OLD_SECRET = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-for-desktop-auth";
  });

  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = OLD_SECRET;
  });

  describe("mintDesktopCode / readDesktopCode", () => {
    it("round-trips the provider and flow hash", () => {
      const { code, flowToken } = require("@/lib/desktop-auth").mintDesktopCode("github");
      const claims = require("@/lib/desktop-auth").readDesktopCode(code);
      expect(claims).not.toBeNull();
      expect(claims.provider).toBe("github");
      expect(claims.flowHash).toBe(crypto.createHash("sha256").update(flowToken).digest("hex"));
      expect(claims.exp).toBeGreaterThan(Date.now());
    });

    it("rejects a tampered payload", () => {
      const { code } = require("@/lib/desktop-auth").mintDesktopCode("google");
      const [payload, signature] = code.split(".");
      const forged = Buffer.from(
        JSON.stringify({ provider: "github", flowHash: "x", exp: Date.now() + 1000 })
      ).toString("base64url");
      expect(require("@/lib/desktop-auth").readDesktopCode(`${forged}.${signature}`)).toBeNull();
      expect(require("@/lib/desktop-auth").readDesktopCode(`${payload}.deadbeef`)).toBeNull();
    });

    it("rejects an expired code", () => {
      const { code } = require("@/lib/desktop-auth").mintDesktopCode("google");
      jest.useFakeTimers().setSystemTime(Date.now() + 6 * 60_000);
      try {
        expect(require("@/lib/desktop-auth").readDesktopCode(code)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("checkDesktopFlow", () => {
    it("accepts the minting browser's token and rejects anything else", () => {
      const lib = require("@/lib/desktop-auth");
      const { code, flowToken } = lib.mintDesktopCode("google");
      const claims = lib.readDesktopCode(code);
      expect(lib.checkDesktopFlow(claims, flowToken)).toBe(true);
      expect(lib.checkDesktopFlow(claims, "other-token")).toBe(false);
      expect(lib.checkDesktopFlow(claims, null)).toBe(false);
      expect(lib.checkDesktopFlow(null, flowToken)).toBe(false);
    });
  });

  describe("mintDesktopGrant / readDesktopGrant", () => {
    it("round-trips the session", () => {
      const lib = require("@/lib/desktop-auth");
      const grant = lib.mintDesktopGrant({
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: "https://example.com/a.png",
      });
      expect(lib.readDesktopGrant(grant)).toEqual({
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        image: "https://example.com/a.png",
      });
    });

    it("rejects a tampered grant", () => {
      const lib = require("@/lib/desktop-auth");
      const grant = lib.mintDesktopGrant({ id: "user-1" });
      const parts = grant.split(".");
      const body = Buffer.from(
        JSON.stringify({ id: "attacker", name: null, email: null, image: null, exp: Date.now() + 1000 })
      ).toString("base64url");
      expect(lib.readDesktopGrant(`${parts[0]}.${parts[1]}.${body}`)).toBeNull();
      expect(lib.readDesktopGrant(`${parts[0]}.${parts[1]}.${parts[2]}x`)).toBeNull();
    });

    it("rejects a grant encrypted with another secret", () => {
      const lib = require("@/lib/desktop-auth");
      const grant = lib.mintDesktopGrant({ id: "user-1" });
      process.env.NEXTAUTH_SECRET = "another-secret";
      expect(lib.readDesktopGrant(grant)).toBeNull();
    });

    it("rejects an expired grant", () => {
      const lib = require("@/lib/desktop-auth");
      const grant = lib.mintDesktopGrant({ id: "user-1" });
      jest.useFakeTimers().setSystemTime(Date.now() + 3 * 60_000);
      try {
        expect(lib.readDesktopGrant(grant)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
