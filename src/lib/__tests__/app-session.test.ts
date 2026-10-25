import { generateKeyPair, exportJWK, SignJWT } from "jose";

describe("app-session", () => {
  const OLD = { ...process.env };

  async function makeKeys() {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const pub = await exportJWK(publicKey);
    const priv = await exportJWK(privateKey);
    process.env.ORPLEX_SESSION_PUBLIC_KEY = Buffer.from(JSON.stringify(pub), "utf8").toString("base64url");
    process.env.ORPLEX_SESSION_PRIVATE_KEY = Buffer.from(JSON.stringify(priv), "utf8").toString("base64url");
    return { pub, priv };
  }

  beforeEach(async () => {
    jest.resetModules();
    await makeKeys();
  });

  afterEach(() => {
    process.env = { ...OLD };
  });

  it("round-trips a signed session", async () => {
    const { signAppSession, verifyAppSession } = require("@/lib/app-session");
    const token = await signAppSession({ id: "user-1", name: "Ada", email: "ada@example.com" });
    expect(token).toBeTruthy();
    const user = await verifyAppSession(token);
    expect(user).toEqual({ id: "user-1", name: "Ada", email: "ada@example.com", image: null });
  });

  it("rejects a token signed with another key", async () => {
    const { signAppSession, verifyAppSession } = require("@/lib/app-session");
    const token = await signAppSession({ id: "user-1" });

    const other = await generateKeyPair("EdDSA", { extractable: true });
    const otherPub = await exportJWK(other.publicKey);
    process.env.ORPLEX_SESSION_PUBLIC_KEY = Buffer.from(JSON.stringify(otherPub), "utf8").toString("base64url");

    expect(await verifyAppSession(token)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const { signAppSession, verifyAppSession } = require("@/lib/app-session");
    const token = await signAppSession({ id: "user-1" });
    expect(await verifyAppSession(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it("rejects a token signed with a raw HS256 secret (no alg confusion)", async () => {
    const { verifyAppSession } = require("@/lib/app-session");
    const hs = await new SignJWT({ id: "attacker" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("secret"));
    expect(await verifyAppSession(hs)).toBeNull();
  });

  it("returns null without a public key", async () => {
    const { signAppSession, verifyAppSession } = require("@/lib/app-session");
    const token = await signAppSession({ id: "user-1" });
    delete process.env.ORPLEX_SESSION_PUBLIC_KEY;
    expect(await verifyAppSession(token)).toBeNull();
  });

  it("reads a cookie value out of a raw Cookie header", () => {
    const { readCookie } = require("@/lib/app-session");
    const header = "a=1; orplex-app-session=abc.def.ghi; b=2";
    expect(readCookie(header, "orplex-app-session")).toBe("abc.def.ghi");
    expect(readCookie(header, "missing")).toBeNull();
    expect(readCookie(null, "orplex-app-session")).toBeNull();
  });
});
