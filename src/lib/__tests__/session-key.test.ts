// Rotating the backend's session key must not sign everybody out.
//
// The app ships a public key inside its installer. When the backend rotates the
// pair, every token signed afterwards fails against the installed key and the
// page gate bounces to /auth/signin with no error anywhere. verifyAppSession()
// therefore retries with the key the backend currently publishes — one cached
// fetch, only after a failed check.

import { generateKeyPair, exportJWK } from "jose";

jest.mock("@/lib/backend-client", () => ({
  backendBaseUrl: () => "https://backend.test",
}));

import { fetchSessionKey, resetSessionKeyCache, bundledSessionKey } from "@/lib/session-key";
import { verifyAppSession } from "@/lib/app-session";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

async function mintToken(privateKey: Parameters<import("jose").SignJWT["sign"]>[0], id = "user-1"): Promise<string> {
  const { SignJWT } = require("jose") as typeof import("jose");
  return new SignJWT({ id, name: "Migrated", email: "m@example.com", image: null })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function pair() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const pub = await exportJWK(publicKey);
  return { privateJwk: privateKey, publicB64: b64({ kty: pub.kty, crv: pub.crv, x: pub.x }), pub };
}

beforeEach(() => {
  jest.restoreAllMocks();
  resetSessionKeyCache();
  process.env.ORPLEX_SESSION_KEY_REMOTE = "1";
  delete process.env.ORPLEX_SESSION_PUBLIC_KEY;
});

afterEach(() => {
  delete process.env.ORPLEX_SESSION_KEY_REMOTE;
  delete process.env.ORPLEX_SESSION_PUBLIC_KEY;
});

function mockKeyEndpoint(publicKey: string) {
  const fn = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, keyId: "k1", publicKey }) }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("bundledSessionKey", () => {
  it("is null when the install carries no key", () => {
    expect(bundledSessionKey()).toBeNull();
  });
});

describe("fetchSessionKey", () => {
  it("fetches once and caches", async () => {
    const { publicB64 } = await pair();
    const fetchMock = mockKeyEndpoint(publicB64);
    const first = await fetchSessionKey();
    const second = await fetchSessionKey();
    expect(first?.publicKey).toBe(publicB64);
    expect(second?.publicKey).toBe(publicB64);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to null when the backend is down (never to a failed signature)", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await fetchSessionKey()).toBeNull();
  });

  it("survives a thrown network error", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchSessionKey()).toBeNull();
  });
});

describe("verifyAppSession across a key rotation", () => {
  it("accepts a token signed with the CURRENT (fetched) key when the bundled key is stale", async () => {
    const stale = await pair();
    const current = await pair();
    process.env.ORPLEX_SESSION_PUBLIC_KEY = stale.publicB64;
    mockKeyEndpoint(current.publicB64);

    const token = await mintToken(current.privateJwk, "user-42");
    const user = await verifyAppSession(token);
    expect(user?.id).toBe("user-42");
  });

  it("still verifies locally, without any fetch, when the bundled key is right", async () => {
    const { publicB64, privateJwk } = await pair();
    process.env.ORPLEX_SESSION_PUBLIC_KEY = publicB64;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = await verifyAppSession(await mintToken(privateJwk));
    expect(user?.id).toBe("user-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a token no key can verify", async () => {
    const stranger = await pair();
    const other = await pair();
    process.env.ORPLEX_SESSION_PUBLIC_KEY = other.publicB64;
    mockKeyEndpoint(other.publicB64);
    expect(await verifyAppSession(await mintToken(stranger.privateJwk))).toBeNull();
  });
});
