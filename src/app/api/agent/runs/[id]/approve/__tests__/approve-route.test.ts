/**
 * approve-route.test.ts — regression for BUG-005 (approval decision TOCTOU).
 *
 * The route must transition a pending approval with a CONDITIONAL update
 * (where: { id, status: "pending" }) so two concurrent decisions cannot both
 * succeed; a lost race (count === 0) must 409. Ownership scoping
 * (run.userId) was already correct; these tests pin the race fix.
 */
import { POST } from "../route";

const mockSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...a: unknown[]) => mockSession(...a),
}));
jest.mock("@/lib/auth", () => ({ jwtOnlyOptions: {} }));

const mockFindFirst = jest.fn();
const mockUpdateMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    approvalRequest: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));

function makeRequest(body: unknown) {
  return {
    json: async () => body,
    url: "http://localhost/api/agent/runs/r1/approve",
  } as never;
}

const ctx = { params: Promise.resolve({ id: "run-1" }) };

describe("POST /api/agent/runs/[id]/approve — decision race (BUG-005)", () => {
  beforeEach(() => {
    mockSession.mockReset();
    mockFindFirst.mockReset();
    mockUpdateMany.mockReset();
    mockSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("uses a conditional updateMany scoped to still-pending rows", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "apr-1", status: "pending" });
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    const res = await POST(makeRequest({ requestId: "apr-1", action: "approve" }), ctx);
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mockUpdateMany.mock.calls[0][0] as {
      where: { id: string; status: string };
      data: { status: string; decidedBy: string };
    };
    expect(arg.where).toEqual({ id: "apr-1", status: "pending" });
    expect(arg.data.status).toBe("approved");
    expect(arg.data.decidedBy).toBe("user-1");
  });

  it("returns 409 when the row was decided concurrently (count 0)", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "apr-1", status: "pending" });
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(makeRequest({ requestId: "apr-1", action: "reject" }), ctx);
    expect(res.status).toBe(409);
    const payload = await (res as Response).json();
    expect(payload.success).toBe(false);
  });

  it("409s without writing when the approval is no longer pending", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "apr-1", status: "expired" });
    const res = await POST(makeRequest({ requestId: "apr-1", action: "approve" }), ctx);
    expect(res.status).toBe(409);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("404s when the approval does not belong to this user's run", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ requestId: "apr-x", action: "approve" }), ctx);
    expect(res.status).toBe(404);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    mockSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ requestId: "apr-1", action: "approve" }), ctx);
    expect(res.status).toBe(401);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
