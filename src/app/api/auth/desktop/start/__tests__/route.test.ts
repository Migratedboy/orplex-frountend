/**
 * The desktop sign-in start route must hand the browser the PROVIDER redirect
 * directly. It used to render a page whose inline script POSTed a form to
 * /api/auth/signin/<provider>; our own CSP (`form-action 'self'`) blocked that
 * POST, so the browser parked on "Taking you to …" forever and OAuth never
 * started.
 */
describe("desktop sign-in start route", () => {
  const OLD_ENV = { ...process.env };

  const loadRoute = () => require("@/app/api/auth/desktop/start/route");

  beforeEach(() => {
    jest.resetModules();
    process.env.NEXTAUTH_SECRET = "test-secret";
    process.env.GOOGLE_CLIENT_ID = "google-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-secret";
    process.env.GITHUB_CLIENT_ID = "github-id";
    process.env.GITHUB_CLIENT_SECRET = "github-secret";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  function mockProviderFetch(location: string) {
    const fetchMock = jest.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/auth/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "__Host-next-auth.csrf-token=csrf-token%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        });
      }
      if (url.includes("/api/auth/signin/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location,
            "set-cookie": "__Host-next-auth.state=state-value; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    return fetchMock;
  }

  it("redirects straight to Google with the OAuth cookies attached", async () => {
    mockProviderFetch("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    const { GET } = loadRoute();
    const res = await GET(new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=google"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c: string) => c.includes("__Host-next-auth.state=state-value"))).toBe(true);
    expect(cookies.some((c: string) => c.includes("orplex_desktop_flow="))).toBe(true);
  });

  it("redirects straight to GitHub", async () => {
    mockProviderFetch("https://github.com/login/oauth/authorize?client_id=x");
    const { GET } = loadRoute();
    const res = await GET(new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=github"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://github.com/login/oauth/authorize?client_id=x");
  });

  it("passes the desktop finish URL as the OAuth callbackUrl", async () => {
    const fetchMock = mockProviderFetch("https://github.com/login/oauth/authorize?client_id=x");
    const { GET } = loadRoute();
    await GET(new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=github"));

    const signinCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/auth/signin/"));
    expect(signinCall).toBeDefined();
    const body = String((signinCall as unknown as [string, RequestInit])[1].body);
    const callbackUrl = decodeURIComponent(new URLSearchParams(body).get("callbackUrl") || "");
    expect(callbackUrl).toMatch(
      /^https:\/\/orplex-backend\.vercel\.app\/api\/auth\/desktop\/finish\?code=[A-Za-z0-9_.-]+$/
    );
  });

  it("refuses to redirect to a host that is not the provider", async () => {
    mockProviderFetch("https://evil.example.com/steal");
    const { GET } = loadRoute();
    const res = await GET(new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=github"));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Sign-in could not start");
  });

  it("ignores a stale csrf cookie from an earlier attempt", async () => {
    const fetchMock = mockProviderFetch("https://github.com/login/oauth/authorize?client_id=x");
    const { GET } = loadRoute();
    const res = await GET(
      new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=github", {
        headers: {
          cookie:
            "__Host-next-auth.csrf-token=stale%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax; other=keep",
        },
      })
    );

    expect(res.status).toBe(302);
    const csrfCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/auth/csrf"));
    expect(csrfCall).toBeDefined();
    const headers = (csrfCall as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    // The stale token must not ride along: NextAuth would reuse it and skip
    // the Set-Cookie, leaving the internal POST without a CSRF cookie.
    expect(headers.cookie || "").not.toContain("csrf-token");
    expect(headers.cookie || "").toContain("other=keep");
  });

  it("reports an unconfigured provider instead of redirecting", async () => {
    process.env.GITHUB_CLIENT_ID = "";
    mockProviderFetch("https://github.com/login/oauth/authorize?client_id=x");
    const { GET } = loadRoute();
    const res = await GET(new Request("https://orplex-backend.vercel.app/api/auth/desktop/start?provider=github"));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("github sign-in is not configured");
  });
});
