// route.test.ts — The events feed's cursor contract: the client passes back
// the returned cursor and never sees a gap or duplicate. Also locks the
// auth/ownership error mapping (401/404).
import { GET } from "../route";

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({ jwtOnlyOptions: {} }));

jest.mock("@/lib/agent/runtime", () => ({
  getRuntimeEvents: jest.fn(),
}));

import { getServerSession } from "next-auth";
import { getRuntimeEvents } from "@/lib/agent/runtime";

const mockedSession = getServerSession as jest.Mock;
const mockedEvents = getRuntimeEvents as jest.Mock;

function makeRequest(after: string) {
  return {
    nextUrl: { searchParams: new URLSearchParams(after ? { after } : {}) },
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("GET /api/agent/runs/[id]/events", () => {
  it("returns events and a cursor at the last sequence", async () => {
    mockedEvents.mockResolvedValue([
      { sequence: 4, type: "claimed" },
      { sequence: 5, type: "worktree-created" },
    ]);

    const res = await GET(makeRequest("3"), { params: Promise.resolve({ id: "run-1" }) });
    const body = await res.json();

    expect(mockedEvents).toHaveBeenCalledWith("user-1", "run-1", 3);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.cursor).toBe(5);
  });

  it("echoes the requested cursor back when there are no new events", async () => {
    mockedEvents.mockResolvedValue([]);

    const res = await GET(makeRequest("7"), { params: Promise.resolve({ id: "run-1" }) });
    const body = await res.json();

    expect(mockedEvents).toHaveBeenCalledWith("user-1", "run-1", 7);
    expect(body.events).toEqual([]);
    expect(body.cursor).toBe(7);
  });

  it("clamps extreme negative cursors to -1 (which includes sequence 0)", async () => {
    mockedEvents.mockResolvedValue([]);

    await GET(makeRequest("-5"), { params: Promise.resolve({ id: "run-1" }) });
    expect(mockedEvents).toHaveBeenCalledWith("user-1", "run-1", -1);
  });

  it("requires authentication", async () => {
    mockedSession.mockResolvedValue(null);

    const res = await GET(makeRequest(""), { params: Promise.resolve({ id: "run-1" }) });
    expect(res.status).toBe(401);
  });

  it("maps ownership failures to 404", async () => {
    mockedEvents.mockRejectedValue(new Error("not yours"));

    const res = await GET(makeRequest("0"), { params: Promise.resolve({ id: "run-1" }) });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
  });
});
