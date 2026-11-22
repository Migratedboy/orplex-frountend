// /api/repos/github — "Pull from GitHub" lists what the signed-in account can
// clone instead of demanding a URL and a personal access token.
//
// Two sources: a GitHub token stored lazily on this machine (dev sign-in), or the
// cloud backend that actually holds the token from the OAuth round-trip. Both
// paths are pinned here, plus the rule that GET never returns a token and POST
// only hands one out for a repo the user can read.

import { GET, POST, scopeHasRepo, toSummary } from "../route";

jest.mock("@/lib/server-session", () => ({ sessionUserId: async () => "user-1" }));
jest.mock("next-auth", () => ({ getServerSession: async () => ({ user: { id: "user-1" } }) }));

const findFirst = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: { account: { findFirst: (...args: unknown[]) => findFirst(...args) } },
}));
jest.mock("@/lib/logger", () => ({ logError: () => undefined, logRequest: () => undefined }));

function rawRepo(over: Record<string, unknown> = {}) {
  return {
    full_name: "acme/site",
    name: "site",
    owner: { login: "acme" },
    private: false,
    default_branch: "main",
    description: "The site",
    updated_at: "2026-01-02T03:04:05Z",
    clone_url: "https://github.com/acme/site.git",
    ...over,
  };
}

/** Response stub with the `link` header the pager reads. */
function gh(body: unknown, init: { status?: number; link?: string } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Map(init.link ? [["link", init.link]] : []) as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const req = () => new Request("http://localhost/api/repos/github") as never;

/** The desktop's own Ed25519 session cookie; without it the backend hop is skipped. */
const withCookie = (fullName?: string) =>
  new Request("http://localhost/api/repos/github", {
    method: fullName ? "POST" : "GET",
    headers: { cookie: "orplex-app-session=signed.app.token", "content-type": "application/json" },
    ...(fullName ? { body: JSON.stringify({ fullName }) } : {}),
  }) as never;

const postReq = (body: unknown) =>
  new Request("http://localhost/api/repos/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  findFirst.mockReset();
  global.fetch = jest.fn() as unknown as typeof fetch;
});

describe("scopeHasRepo", () => {
  it("recognises repo-ish scopes in comma and space separated form", () => {
    expect(scopeHasRepo("read:user,user:email,repo")).toBe(true);
    expect(scopeHasRepo("public_repo gist")).toBe(true);
    expect(scopeHasRepo("read:user user:email")).toBe(false);
    expect(scopeHasRepo(null)).toBe(false);
  });
});

describe("toSummary", () => {
  it("keeps only the fields the picker uses", () => {
    expect(toSummary(rawRepo())).toEqual({
      fullName: "acme/site",
      owner: "acme",
      name: "site",
      private: false,
      defaultBranch: "main",
      description: "The site",
      updatedAt: "2026-01-02T03:04:05Z",
      cloneUrl: "https://github.com/acme/site.git",
    });
  });

  it("rejects a row without an owner instead of rendering a broken entry", () => {
    expect(toSummary({ full_name: "acme/site", owner: {} })).toBeNull();
    expect(toSummary({})).toBeNull();
  });
});

describe("GET /api/repos/github", () => {
  it("reports not-connected when the account has no GitHub token", async () => {
    findFirst.mockResolvedValue(null);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ success: true, connected: false, repos: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("says install-the-app when a GitHub App token reaches no repositories", async () => {
    // A user-to-server token only sees repositories the app is INSTALLED on.
    // Authorising is not installing, so an empty list here means the second
    // half of the flow is missing — not that the account has no repos.
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ access_token: "ghu_app", scope: "repo" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(gh([]))
      .mockResolvedValueOnce(gh({ login: "migratedboy" }))
      .mockResolvedValueOnce(gh({ total_count: 0, installations: [] }));

    const body = await (await GET(req())).json();
    expect(body.needsInstall).toBe(true);
    expect(typeof body.installUrl).toBe("string");
  });

  it("does not cry install when the app is installed but the account is empty", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ access_token: "ghu_app", scope: "repo" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(gh([]))
      .mockResolvedValueOnce(gh({ login: "migratedboy" }))
      .mockResolvedValueOnce(gh({ total_count: 1 }));

    const body = await (await GET(req())).json();
    expect(body.needsInstall).toBe(false);
  });

  it("never claims a missing install for an OAuth token", async () => {
    findFirst.mockResolvedValueOnce({ access_token: "gho_oauth", scope: "repo" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(gh([]))
      .mockResolvedValueOnce(gh({ login: "migratedboy" }));

    const body = await (await GET(req())).json();
    expect(body.needsInstall).toBe(false);
    expect(body.source).toBe("oauth");
  });
  it("lists repositories, deduplicates and flags missing scope", async () => {
    findFirst.mockResolvedValue({ access_token: "tok", scope: "read:user" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(gh([rawRepo(), rawRepo({ full_name: "acme/api", name: "api" })]))
      .mockResolvedValueOnce(gh({ login: "migratedboy" }));

    const body = await (await GET(req())).json();
    expect(body.connected).toBe(true);
    expect(body.needsScope).toBe(true);
    expect(body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/site", "acme/api"]);
    // Token never leaves the server.
    expect(JSON.stringify(body)).not.toContain("tok");
  });

  it("follows pagination to the next page", async () => {
    findFirst.mockResolvedValue({ access_token: "tok", scope: "repo" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        gh([rawRepo()], { link: '<https://api.github.com/user/repos?page=2>; rel="next"' })
      )
      .mockResolvedValueOnce(gh([rawRepo({ full_name: "acme/next", name: "next" })]))
      .mockResolvedValueOnce(gh({ login: "migratedboy" }));

    const body = await (await GET(req())).json();
    expect(body.needsScope).toBe(false);
    expect(body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/site", "acme/next"]);
  });

  it("treats a rejected token as a reconnect, not an empty account", async () => {
    findFirst.mockResolvedValue({ access_token: "expired", scope: "repo" });
    (global.fetch as jest.Mock).mockResolvedValueOnce(gh({ message: "Bad credentials" }, { status: 401 }));

    const body = await (await GET(req())).json();
    expect(body.connected).toBe(false);
    expect(body.needsScope).toBe(true);
    expect(body.error).toMatch(/Connect GitHub again/i);
  });

  it("surfaces the rate limit without losing what it already read", async () => {
    findFirst.mockResolvedValue({ access_token: "tok", scope: "repo" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(gh([rawRepo()], { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }))
      .mockResolvedValueOnce(gh({ message: "rate limited" }, { status: 403 }));

    const body = await (await GET(req())).json();
    expect(body.repos).toHaveLength(1);
    expect(body.error).toMatch(/rate limit/i);
  });

  // The desktop sign-in never stores provider tokens locally — the backend that
  // ran the OAuth round-trip does. Without this hop every real install showed an
  // empty picker.
  it("forwards to the backend when there is no local token", async () => {
    findFirst.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      gh({
        connected: true,
        login: "migratedboy",
        needsScope: false,
        repos: [rawRepo({ full_name: "me/private-one", private: true })].map((r) => toSummary(r)),
      })
    );

    const body = await (await GET(withCookie())).json();
    expect(body).toMatchObject({ connected: true, login: "migratedboy", source: "backend" });
    expect(body.repos).toHaveLength(1);
  });

  it("does not forward anything when the app has no session cookie", async () => {
    findFirst.mockResolvedValue(null);
    const body = await (await GET(req())).json();
    expect(body.connected).toBe(false);
    expect(body.error).toMatch(/No cloud account/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/repos/github (clone credential)", () => {
  it("rejects a repo name that could escape the owner/repo shape", async () => {
    findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ fullName: "../../etc" }));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the backend's token for a private repo", async () => {
    findFirst.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValueOnce(gh({ success: true, token: "gho_frombackend" }));
    const body = await (await POST(withCookie("acme/private-one"))).json();
    expect(body).toMatchObject({ success: true, token: "gho_frombackend", source: "backend" });
  });

  it("refuses to invent a credential when the backend has none", async () => {
    findFirst.mockResolvedValue(null);
    (global.fetch as jest.Mock).mockResolvedValueOnce(gh({ success: false, error: "Not connected" }, { status: 400 }));
    const res = await POST(withCookie("acme/private-one"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.json()).toMatchObject({ success: false });
  });
});
