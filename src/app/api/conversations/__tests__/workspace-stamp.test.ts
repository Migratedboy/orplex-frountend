/**
 * workspace-stamp.test.ts — /api/conversations POST stamps the thread with
 * the workspace folder it was created in: create sets the tag (sanitized),
 * update refreshes it when provided and leaves it untouched when omitted.
 * Prisma is mocked at the module boundary — this suite pins the ROUTE's
 * contract (what data it writes), not the DB.
 */
import { POST } from "../route";

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({ jwtOnlyOptions: {} }));

// prismaMock is created lazily inside the mock factory and re-exported via
// jest.requireMock — jest.mock factories are hoisted above const declarations,
// so referencing an outer const directly would throw TDZ errors.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    user: { upsert: jest.fn().mockResolvedValue({}) },
    conversation: { update: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  },
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

const prismaMock = prisma as unknown as {
  user: { upsert: jest.Mock };
  conversation: { update: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
};
const mockedSession = getServerSession as jest.Mock;

function makePost(body: Record<string, unknown>) {
  return {
    json: async () => body,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSession.mockResolvedValue({ user: { id: "user-1" } });
  prismaMock.conversation.create.mockResolvedValue({ id: "new-conv" });
  prismaMock.conversation.update.mockResolvedValue({ id: "existing-conv" });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: "existing-conv" });
});

describe("POST /api/conversations — workspaceName stamping", () => {
  it("stamps workspaceName on CREATE (trimmed, capped)", async () => {
    const res = await POST(makePost({
      messages: [{ role: "user", content: "hello" }],
      workspaceName: "  orplex  ",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversationId).toBe("new-conv");
    expect(prismaMock.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceName: "orplex" }) })
    );
  });

  it("nulls the tag when absent/empty/whitespace on CREATE (Ungrouped)", async () => {
    for (const workspaceName of [undefined, "", "   ", null]) {
      (prismaMock.conversation.create.mockClear() as unknown as void);
      await POST(makePost({ messages: [{ role: "user", content: "hi" }], workspaceName: workspaceName as string | null | undefined }));
      expect(prismaMock.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ workspaceName: null }) })
      );
    }
  });

  it("caps over-long names at 120 chars", async () => {
    await POST(makePost({ messages: [{ role: "user", content: "hi" }], workspaceName: "x".repeat(300) }));
    expect(prismaMock.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceName: "x".repeat(120) }) })
    );
  });

  it("UPDATE refreshes workspaceName when provided", async () => {
    await POST(makePost({
      conversationId: "existing-conv",
      messages: [{ role: "user", content: "more" }],
      workspaceName: "logo",
    }));

    // Ownership is gated first (findFirst), then the update runs by id —
    // update({ where: { id, userId } }) is invalid Prisma (not unique).
    expect(prismaMock.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "existing-conv", userId: "user-1" } })
    );
    expect(prismaMock.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "existing-conv" },
        data: expect.objectContaining({ workspaceName: "logo" }),
      })
    );
  });

  it("UPDATE omits the field entirely when not provided (existing tag never wiped)", async () => {
    await POST(makePost({
      conversationId: "existing-conv",
      messages: [{ role: "user", content: "more" }],
    }));

    const call = prismaMock.conversation.update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("workspaceName");
    expect(call.data.messages).toBeDefined();
  });

  it("UPDATE 404s on a conversation owned by someone else", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    const res = await POST(makePost({
      conversationId: "existing-conv",
      messages: [{ role: "user", content: "more" }],
    }));
    expect(res.status).toBe(404);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mockedSession.mockResolvedValue(null);
    const res = await POST(makePost({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
  });

  it("rejects bodies without messages", async () => {
    const res = await POST(makePost({ workspaceName: "orplex" }));
    expect(res.status).toBe(400);
  });
});
