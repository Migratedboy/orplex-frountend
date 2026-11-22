// GitHub App device flow — the desktop's own repository credential.
//
// These tests pin the parts that are easy to get wrong and impossible to see by
// clicking: a flow belongs to one user, polling is one-shot (the client owns the
// cadence), a dead code is dropped instead of retried forever, and the token is
// only stored once GitHub actually says "authorized".

const upsert = jest.fn();
const findFirst = jest.fn();
const deleteMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      upsert: (...a: unknown[]) => upsert(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import {
  clearAppToken,
  GITHUB_APP_PROVIDER,
  githubAppClientId,
  pollDeviceFlow,
  readGithubToken,
  startDeviceFlow,
} from "@/lib/github-app";

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue({});
  findFirst.mockReset().mockResolvedValue(null);
  deleteMany.mockReset().mockResolvedValue({});
  global.fetch = jest.fn() as unknown as typeof fetch;
  delete process.env.GITHUB_APP_CLIENT_ID;
  delete process.env.GITHUB_DEVICE_CLIENT_ID;
});

afterEach(() => {
  delete process.env.GITHUB_APP_CLIENT_ID;
  delete process.env.GITHUB_DEVICE_CLIENT_ID;
});

describe("configuration", () => {
  it("reports unconfigured when the client id is missing or a placeholder", () => {
    expect(githubAppClientId()).toBeNull();
    process.env.GITHUB_APP_CLIENT_ID = "your_client_id";
    expect(githubAppClientId()).toBeNull();
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc123";
    expect(githubAppClientId()).toBe("Iv1.abc123");
  });

  it("refuses to start a flow without a client id (no half-auth state)", async () => {
    expect(await startDeviceFlow("user-1")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("which app the device flow uses", () => {
  it("prefers the OAuth App and asks for repo scope", async () => {
    // An OAuth token needs no install step; a GitHub App token does. Ordering is
    // the difference between "type a code" and "type a code, then install".
    process.env.GITHUB_DEVICE_CLIENT_ID = "Ov23liOauth";
    process.env.GITHUB_APP_CLIENT_ID = "Iv23liApp";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      json({ device_code: "d", user_code: "U-1", expires_in: 900, interval: 5 })
    );

    const flow = await startDeviceFlow("user-1");
    expect(flow?.source).toBe("oauth");
    const sent = String((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent).toContain("client_id=Ov23liOauth");
    expect(sent).toContain("scope=repo");
  });

  it("falls through to the GitHub App when the OAuth app has device flow off", async () => {
    process.env.GITHUB_DEVICE_CLIENT_ID = "Ov23liOauth";
    process.env.GITHUB_APP_CLIENT_ID = "Iv23liApp";
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(json({ error: "device_flow_disabled", error_description: "nope" }, 400))
      .mockResolvedValueOnce(json({ device_code: "d", user_code: "U-2", expires_in: 900, interval: 5 }));

    const flow = await startDeviceFlow("user-1");
    expect(flow?.source).toBe("app");
    expect(flow?.userCode).toBe("U-2");
  });

  it("stores an OAuth device token under provider github, not github-app", async () => {
    // Otherwise the repo list would treat it like an App token and nag about an
    // installation that the OAuth flow never needed.
    process.env.GITHUB_DEVICE_CLIENT_ID = "Ov23liOauth";
    delete process.env.GITHUB_APP_CLIENT_ID;
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      json({ device_code: "d", user_code: "U-3", expires_in: 900, interval: 5 })
    );
    const flow = (await startDeviceFlow("user-1"))!;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(json({ access_token: "gho_tok", scope: "repo" }))
      .mockResolvedValueOnce(json({ login: "migratedboy" }));

    await pollDeviceFlow(flow.flowId, "user-1");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ provider: "github", access_token: "gho_tok" }),
      })
    );
  });
});
describe("startDeviceFlow", () => {
  it("asks GitHub for a code and hands the user code to the client", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc123";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      json({
        device_code: "dev-secret",
        user_code: "WXYZ-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      })
    );

    const flow = await startDeviceFlow("user-1");
    expect(flow).toMatchObject({ userCode: "WXYZ-1234", expiresIn: 900, interval: 5 });
    expect(flow?.flowId).toBeTruthy();
    // The device code is a credential: it stays server-side.
    expect(JSON.stringify(flow)).not.toContain("dev-secret");
  });

  it("returns null when GitHub omits the codes", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc123";
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({}));
    expect(await startDeviceFlow("user-1")).toBeNull();
  });

  it("surfaces GitHub's own refusal in words, including on a 400 (device flow off)", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv23li";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      json(
        { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" },
        400
      )
    );
    await expect(startDeviceFlow("user-1")).rejects.toThrow(/Device Flow must be explicitly enabled/);
  });

  it("does not answer a bare status when GitHub sends no explanation", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv23li";
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({}, 500));
    await expect(startDeviceFlow("user-1")).rejects.toThrow(/GitHub responded 500/);
  });
});

describe("pollDeviceFlow", () => {
  async function started() {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc123";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      json({ device_code: "dev-secret", user_code: "CODE-1", expires_in: 900, interval: 5 })
    );
    return (await startDeviceFlow("user-1"))!;
  }

  it("stays pending until the user authorises", async () => {
    const flow = await started();
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({ error: "authorization_pending" }));
    expect(await pollDeviceFlow(flow.flowId, "user-1")).toEqual({ status: "pending" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("asks the client to slow down instead of hammering GitHub", async () => {
    const flow = await started();
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({ error: "slow_down" }));
    expect(await pollDeviceFlow(flow.flowId, "user-1")).toEqual({ status: "slow_down" });
  });

  it("stores the token locally on success and reports the login", async () => {
    const flow = await started();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(json({ access_token: "ghu_token", scope: "repo", token_type: "bearer" }))
      .mockResolvedValueOnce(json({ login: "migratedboy" }));

    const result = await pollDeviceFlow(flow.flowId, "user-1");
    expect(result).toEqual({ status: "authorized", login: "migratedboy" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerAccountId: { provider: GITHUB_APP_PROVIDER, providerAccountId: "migratedboy" } },
        create: expect.objectContaining({
          userId: "user-1",
          provider: GITHUB_APP_PROVIDER,
          access_token: "ghu_token",
        }),
      })
    );
  });

  it("does not re-poll GitHub once authorized", async () => {
    const flow = await started();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(json({ access_token: "ghu_token" }))
      .mockResolvedValueOnce(json({ login: "migratedboy" }));
    await pollDeviceFlow(flow.flowId, "user-1");
    const callsAfterAuth = (global.fetch as jest.Mock).mock.calls.length;

    expect((await pollDeviceFlow(flow.flowId, "user-1")).status).toBe("authorized");
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterAuth);
  });

  it("refuses another user's flow", async () => {
    const flow = await started();
    expect(await pollDeviceFlow(flow.flowId, "someone-else")).toEqual({ status: "expired" });
  });

  it("treats an unknown flow as expired", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc123";
    expect(await pollDeviceFlow("nope", "user-1")).toEqual({ status: "expired" });
  });

  it("reports a denial and an expired code distinctly", async () => {
    const a = await started();
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({ error: "access_denied" }));
    expect((await pollDeviceFlow(a.flowId, "user-1")).status).toBe("denied");

    const b = await started();
    (global.fetch as jest.Mock).mockResolvedValueOnce(json({ error: "expired_token" }));
    expect((await pollDeviceFlow(b.flowId, "user-1")).status).toBe("expired");
  });
});

describe("readGithubToken", () => {
  it("prefers the OAuth token, which needs no installation", async () => {
    findFirst.mockResolvedValueOnce({ access_token: "gho_oauth", scope: "repo" });
    expect(await readGithubToken("user-1")).toEqual({ token: "gho_oauth", scope: "repo", source: "oauth" });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("falls back to a GitHub App token", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ access_token: "ghu_app", scope: "repo" });
    expect(await readGithubToken("user-1")).toEqual({ token: "ghu_app", scope: "repo", source: "github-app" });
  });

  it("returns null when nothing is stored", async () => {
    expect(await readGithubToken("user-1")).toBeNull();
  });
});

describe("clearAppToken", () => {
  it("deletes only the device-flow rows", async () => {
    await clearAppToken("user-1");
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", provider: GITHUB_APP_PROVIDER } });
  });

  it("never throws when the delete fails", async () => {
    deleteMany.mockRejectedValueOnce(new Error("db down"));
    await expect(clearAppToken("user-1")).resolves.toBeUndefined();
  });
});
