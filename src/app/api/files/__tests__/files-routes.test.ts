/**
 * files-routes.test.ts — the staged-file API.
 *
 * The create_file store only works if the routes never leak or misreport:
 * auth (same JWT contract as workspace-cwd), filename/content validation,
 * the size ceiling, the honest three-state reads over 200/410, and the
 * attachment download path.
 */

const sessionUserId = jest.fn();

jest.mock("@/lib/server-session", () => ({
  sessionUserId: (req: unknown) => sessionUserId(req),
}));

type PostRoute = { POST: (req: unknown) => Promise<Response> };
type IdRoute = { GET: (req: unknown, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };

function postReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as never;
}

function getReq(search = "") {
  return {
    nextUrl: { searchParams: new URLSearchParams(search) },
  } as unknown as never;
}

beforeEach(() => {
  jest.resetModules();
  sessionUserId.mockResolvedValue("user-1");
});

describe("POST /api/files", () => {
  const load = async (): Promise<PostRoute> =>
    (await import("../route")) as unknown as PostRoute;

  it("answers 401 without a session", async () => {
    sessionUserId.mockResolvedValue(null);
    const { POST } = await load();
    const res = await POST(postReq({ filename: "a.md", content: "x" }));
    expect(res.status).toBe(401);
  });

  it("rejects invalid filenames with 400", async () => {
    const { POST } = await load();
    const res = await POST(postReq({ filename: "../evil.md", content: "x" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { code?: string };
    expect(j.code).toBe("invalid_filename");
  });

  it("rejects oversized content with 413", async () => {
    const { POST } = await load();
    // 2MB of JSON inflates past the pre-parse guard AND the store cap.
    const res = await POST(postReq({ filename: "big.md", content: "x".repeat(3_000_000) }));
    expect(res.status).toBe(413);
  });

  it("stages a valid file and reports card metadata", async () => {
    const { POST } = await load();
    const res = await POST(
      postReq({ filename: "notes.md", content: "# hi", conversationId: "conv-7" })
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id?: string; filename?: string; bytes?: number; evicted?: unknown };
    expect(j.id).toBeTruthy();
    expect(j.filename).toBe("notes.md");
    expect(j.bytes).toBe(4);
    expect(j.evicted).toBeNull();
  });

  it("reports eviction honestly when the 2-file cap fires", async () => {
    const { POST, } = await load();
    const first = await POST(postReq({ filename: "one.md", content: "1" }));
    const second = await POST(postReq({ filename: "two.md", content: "2" }));
    const firstId = ((await first.json()) as { id: string }).id;
    const firstRes = first;
    const secondRes = second;
    const third = await POST(postReq({ filename: "three.md", content: "3" }));
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const thirdJ = (await third.json()) as { evicted?: { id: string; filename: string } | null };
    expect(thirdJ.evicted).toEqual({ id: firstId, filename: "one.md" });
  });
});

describe("GET /api/files/:id", () => {
  const load = async (): Promise<IdRoute> =>
    (await import("../[id]/route")) as unknown as IdRoute;

  it("answers 401 without a session", async () => {
    sessionUserId.mockResolvedValue(null);
    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id: "x".repeat(16) }) });
    expect(res.status).toBe(401);
  });

  it("answers 410 with a state for unknown ids", async () => {
    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(res.status).toBe(410);
    const j = (await res.json()) as { state: string };
    expect(j.state).toBe("removed");
  });

  it("serves staged content as JSON on the live path", async () => {
    // Stage through the POST route so both share the same store instance.
    const post = (await import("../route")) as unknown as PostRoute;
    const created = await post.POST(postReq({ filename: "live.md", content: "abc" }));
    const { id } = (await created.json()) as { id: string };

    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { state: string; filename: string; content: string };
    expect(j.state).toBe("live");
    expect(j.filename).toBe("live.md");
    expect(j.content).toBe("abc");
  });

  it("serves an attachment download with the staged filename", async () => {
    const post = (await import("../route")) as unknown as PostRoute;
    const created = await post.POST(postReq({ filename: "dl.sum", content: "payload" }));
    const { id } = (await created.json()) as { id: string };

    const { GET } = await load();
    const res = await GET(getReq("download=1"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="dl.sum"');
    expect(await res.text()).toBe("payload");
  });
});

describe("GET /api/files/:id/status", () => {
  const load = async () =>
    (await import("../[id]/status/route")) as unknown as IdRoute;

  it("answers 401 without a session", async () => {
    sessionUserId.mockResolvedValue(null);
    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id: "x".repeat(16) }) });
    expect(res.status).toBe(401);
  });

  it("answers live for a staged file", async () => {
    const post = (await import("../route")) as unknown as PostRoute;
    const created = await post.POST(postReq({ filename: "s.md", content: "x" }));
    const { id } = (await created.json()) as { id: string };

    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { state: string };
    expect(j.state).toBe("live");
  });

  it("answers removed for ids the store never knew", async () => {
    const { GET } = await load();
    const res = await GET(getReq(), { params: Promise.resolve({ id: "deadbeef-dead-beef-dead-beefdeadbeef" }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { state: string };
    expect(j.state).toBe("removed");
  });
});
