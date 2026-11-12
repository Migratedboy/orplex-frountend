/**
 * desktop link route — the mediator site's sign-in page (opened by the app
 * in app mode) calls this after a successful sign-in to mint the one-time
 * encrypted grant the desktop app redeems at /api/auth/desktop/exchange.
 * Mirrors the backend route so self-hosted mode mints identically.
 */

jest.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: jest.fn(() => ({ allowed: true })),
  clientIp: () => "127.0.0.1",
}));

jest.mock("@/lib/auth", () => ({
  jwtOnlyOptions: {},
}));

const getServerSession = jest.fn();

jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

type PostRoute = { POST: (req: unknown) => Promise<Response> };

export {};

function postReq() {
  return {
    headers: new Headers(),
    json: async () => ({}),
  } as unknown as never;
}

describe("desktop auth link route (site-mediated sign-in)", () => {
  const OLD_SECRET = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    jest.resetModules();
    process.env.NEXTAUTH_SECRET = "link-test-secret";
    getServerSession.mockReset();
  });

  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = OLD_SECRET;
  });

  const loadRoute = (): PostRoute => require("@/app/api/auth/desktop/link/route");

  it("mints a grant for a signed-in site session", async () => {
    getServerSession.mockResolvedValue({
      user: { id: "user-42", name: "Ada", email: "ada@example.com", image: null },
    });
    const { POST } = loadRoute();

    const res = await POST(postReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("user-42");
    expect(typeof body.grant).toBe("string");
    expect(body.grant.split(".").length).toBe(3); // iv.tag.ciphertext

    // The grant must redeem on the existing exchange route.
    const { readDesktopGrant } = require("@/lib/desktop-auth");
    const session = readDesktopGrant(body.grant);
    expect(session?.id).toBe("user-42");
    expect(session?.email).toBe("ada@example.com");
  });

  it("rejects an anonymous caller (no site session)", async () => {
    getServerSession.mockResolvedValue(null);
    const { POST } = loadRoute();

    const res = await POST(postReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rate-limits repeated attempts", async () => {
    getServerSession.mockResolvedValue({
      user: { id: "user-42", name: "Ada", email: "ada@example.com" },
    });
    const { checkRateLimit } = require("@/lib/rate-limiter");
    (checkRateLimit as jest.Mock).mockReturnValue({ allowed: false });
    const { POST } = loadRoute();

    const res = await POST(postReq());
    expect(res.status).toBe(429);
    expect(getServerSession).not.toHaveBeenCalled();
  });
});
