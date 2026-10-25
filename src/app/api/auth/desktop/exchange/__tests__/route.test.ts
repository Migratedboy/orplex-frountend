/**
 * desktop exchange route — the app redeems the encrypted grant that the
 * finish route minted after the OAuth round-trip. The grant must be
 * self-contained (the exchange can land on another serverless instance),
 * tamper-proof and short-lived.
 */

const userUpsert = jest.fn();

jest.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: (...args: unknown[]) => userUpsert(...args),
    },
  },
}));

jest.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: () => ({ allowed: true }),
  clientIp: () => "127.0.0.1",
}));

type PostRoute = { POST: (req: unknown) => Promise<Response> };

export {};

function postReq(body: unknown) {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as never;
}

describe("desktop auth exchange route", () => {
  const OLD_SECRET = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    jest.resetModules();
    process.env.NEXTAUTH_SECRET = "exchange-test-secret";
    userUpsert.mockReset();
    userUpsert.mockResolvedValue({});
  });

  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = OLD_SECRET;
  });

  const loadRoute = (): PostRoute => require("@/app/api/auth/desktop/exchange/route");

  it("redeems a valid grant and sets the session cookies", async () => {
    const { mintDesktopGrant } = require("@/lib/desktop-auth");
    const grant = mintDesktopGrant({ id: "user-42", name: "Ada", email: "ada@example.com" });
    const { POST } = loadRoute();

    const res = await POST(postReq({ code: grant }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("user-42");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c: string) => c.startsWith("next-auth.session-token="))).toBe(true);
    expect(cookies.some((c: string) => c.startsWith("__Secure-next-auth.session-token="))).toBe(true);
    expect(userUpsert).toHaveBeenCalled();
  });

  it("also issues the app session the desktop app verifies locally", async () => {
    const { generateKeyPair, exportJWK } = await import("jose");
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const pub = await exportJWK(publicKey);
    const priv = await exportJWK(privateKey);
    process.env.ORPLEX_SESSION_PUBLIC_KEY = Buffer.from(JSON.stringify(pub), "utf8").toString("base64url");
    process.env.ORPLEX_SESSION_PRIVATE_KEY = Buffer.from(JSON.stringify(priv), "utf8").toString("base64url");

    const { mintDesktopGrant } = require("@/lib/desktop-auth");
    const grant = mintDesktopGrant({ id: "user-42" });
    const { POST } = loadRoute();

    const res = await POST(postReq({ code: grant }));
    const cookie = res.headers
      .getSetCookie()
      .find((c: string) => c.startsWith("orplex-app-session="));
    expect(cookie).toBeTruthy();

    const { verifyAppSession } = require("@/lib/app-session");
    const value = decodeURIComponent(cookie!.split(";")[0].split("=").slice(1).join("="));
    const user = await verifyAppSession(value);
    expect(user?.id).toBe("user-42");

    delete process.env.ORPLEX_SESSION_PUBLIC_KEY;
    delete process.env.ORPLEX_SESSION_PRIVATE_KEY;
  });

  it("rejects a forged grant", async () => {
    const { POST } = loadRoute();
    const res = await POST(postReq({ code: "not.a.grant" }));
    expect(res.status).toBe(401);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("rejects a grant encrypted with a different secret", async () => {
    const { mintDesktopGrant } = require("@/lib/desktop-auth");
    const grant = mintDesktopGrant({ id: "user-42" });
    process.env.NEXTAUTH_SECRET = "a-different-secret";
    const { POST } = loadRoute();

    const res = await POST(postReq({ code: grant }));
    expect(res.status).toBe(401);
  });

  it("rejects an empty code", async () => {
    const { POST } = loadRoute();
    const res = await POST(postReq({ code: "" }));
    expect(res.status).toBe(401);
  });
});
