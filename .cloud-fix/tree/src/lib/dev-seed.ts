// dev-seed.ts — Seeds sample data for the dev-user so E2E tests (and manual
// dev sessions) exercise NON-EMPTY UI states: conversation history in the
// sidebar, quota usage on the meter, and a workspace membership.
//
// Only reachable through /api/dev/session?action=seed, which is disabled
// outside development (NODE_ENV=production), so this can never run against a
// real deployment. All rows use fixed ids and are fully idempotent — seeding
// repeatedly upserts the conversations, replaces their messages, refreshes
// the quota counters, and recreates the workspace membership.

import { prisma } from "./prisma";

export const DEV_SEED_USER_ID = "dev-user";

export const SEED_WORKSPACE_ID = "seed-workspace-acme";
export const SEED_WORKSPACE_NAME = "Acme Sample Workspace";

export const SEED_CONVERSATION_IDS = {
  landing: "seed-conv-landing",
  e2eTimeout: "seed-conv-e2e-timeout",
  darkMode: "seed-conv-dark-mode",
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

interface SeedConversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: SeedMessage[];
}

export interface SeedSummary {
  ok: boolean;
  conversations: { id: string; title: string; messageCount: number }[];
  /** null when the dev database hasn't been provisioned with the workspaces
   *  tables yet (schema added after the last `prisma db push`). */
  workspace: { id: string; name: string; role: string } | null;
  quota: { requestsToday: number; dailyLimit: number; tier: string };
  usageLogs: number;
}

/** Build the sample conversations relative to `now` (newest first). */
function buildConversations(now: Date): SeedConversation[] {
  return [
    {
      // Most recent — created at seed time so it tops the sidebar's
      // "Recent Chats" list even after earlier tests saved conversations.
      id: SEED_CONVERSATION_IDS.landing,
      title: "Bakery landing page — first pass",
      createdAt: new Date(now.getTime() - 50 * MIN),
      updatedAt: now,
      messages: [
        {
          role: "user",
          content:
            "Build a landing page for my bakery called Golden Crumb. Single page: hero, menu highlights, hours, and a contact strip.",
          createdAt: new Date(now.getTime() - 50 * MIN),
        },
        {
          role: "assistant",
          content: [
            "Here is the plan for Golden Crumb:",
            "",
            "1. Hero with a warm cream background",
            "2. Menu highlights (sourdough, croissants)",
            "3. Hours + phone (555) 010-2233",
            "4. Contact strip with the address",
            "",
            "Starting with the hero section, then iterating from there.",
          ].join("\n"),
          createdAt: new Date(now.getTime() - 49 * MIN),
        },
        {
          role: "user",
          content:
            "Make the hero background warm cream and show the phone number under the tagline.",
          createdAt: new Date(now.getTime() - 30 * MIN),
        },
        {
          role: "assistant",
          content:
            "Done. The hero now uses #FFF8EF and (555) 010-2233 sits under the tagline. Next up: menu highlights.",
          createdAt: new Date(now.getTime() - 29 * MIN),
        },
      ],
    },
    {
      id: SEED_CONVERSATION_IDS.e2eTimeout,
      title: "Fix flaky E2E timeout in CI",
      createdAt: new Date(now.getTime() - 3 * HOUR),
      updatedAt: new Date(now.getTime() - 2 * HOUR),
      messages: [
        {
          role: "user",
          content:
            "Our E2E login test times out in CI about half the time. Where should I start looking?",
          createdAt: new Date(now.getTime() - 3 * HOUR),
        },
        {
          role: "assistant",
          content: [
            "Three usual suspects:",
            "",
            "1. Dev-server warm-up — add a health poll before tests run",
            "2. The boot splash overlay hiding the page",
            "3. No retry strategy on the first page load",
            "",
            "Fix the webServer readiness check first; it causes most CI flakes.",
          ].join("\n"),
          createdAt: new Date(now.getTime() - 2.9 * HOUR),
        },
        {
          role: "user",
          content: "We don't have real OAuth creds in CI. What else can we use?",
          createdAt: new Date(now.getTime() - 2.1 * HOUR),
        },
        {
          role: "assistant",
          content:
            "Use the dev-only session bypass — /api/dev/session?action=login mints a real signed cookie, so the suite stays green without Google or GitHub.",
          createdAt: new Date(now.getTime() - 2 * HOUR),
        },
      ],
    },
    {
      id: SEED_CONVERSATION_IDS.darkMode,
      title: "Dark mode contrast audit",
      createdAt: new Date(now.getTime() - 2 * DAY),
      updatedAt: new Date(now.getTime() - 1 * DAY),
      messages: [
        {
          role: "user",
          content:
            "Audit dark mode: several muted grays are too low-contrast on the near-black background.",
          createdAt: new Date(now.getTime() - 2 * DAY),
        },
        {
          role: "assistant",
          content: [
            "Raised minimum text contrast to 4.5:1:",
            "",
            "- Secondary text: #71717A → #A1A1AA",
            "- Borders: #27272A → #3F3F46",
            "- Focus rings stay on the orange accent",
          ].join("\n"),
          createdAt: new Date(now.getTime() - 2 * DAY + 30 * MIN),
        },
      ],
    },
  ];
}

/**
 * Seed (or refresh) the dev-user's sample data. Idempotent and safe to call
 * on every dev login — fixed ids make repeated runs converge to the same
 * state instead of duplicating rows.
 */
export async function seedDevData(): Promise<SeedSummary> {
  const now = new Date();

  // The dev user must exist first (FK constraints on every table below).
  await prisma.user.upsert({
    where: { id: DEV_SEED_USER_ID },
    update: {},
    create: { id: DEV_SEED_USER_ID, name: "Dev User", email: "dev@orplex.local" },
  });

  // --- Conversations + messages (fixed ids, replace messages each seed) ---
  const convos = buildConversations(now);
  await prisma.$transaction(async (tx) => {
    for (const conv of convos) {
      await tx.conversation.upsert({
        where: { id: conv.id },
        update: { title: conv.title, updatedAt: conv.updatedAt },
        create: {
          id: conv.id,
          title: conv.title,
          userId: DEV_SEED_USER_ID,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        },
      });
      await tx.message.deleteMany({ where: { conversationId: conv.id } });
      await tx.message.createMany({
        data: conv.messages.map((m) => ({
          conversationId: conv.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    }
  });

  // --- Quota usage: meter reads "used/limit requests today" ---
  const QUOTA_USED_TODAY = 12; // well under the free limit of 1000 — chat still works
  const existingQuota = await prisma.userQuota.findUnique({
    where: { userId: DEV_SEED_USER_ID },
  });
  const quota = existingQuota
    ? await prisma.userQuota.update({
        where: { userId: DEV_SEED_USER_ID },
        data: {
          requestsToday: QUOTA_USED_TODAY,
          dailyLimit: 1000,
          tier: "free",
          lastResetAt: now,
        },
      })
    : await prisma.userQuota.create({
        data: {
          userId: DEV_SEED_USER_ID,
          requestsToday: QUOTA_USED_TODAY,
          dailyLimit: 1000,
          tier: "free",
          lastResetAt: now,
        },
      });

  // --- Usage history rows (no UI today, but backs the data story) ---
  const logs = [
    { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", tokensIn: 420, tokensOut: 310, latencyMs: 840, success: true, createdAt: new Date(now.getTime() - 5 * MIN) },
    { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", tokensIn: 610, tokensOut: 520, latencyMs: 1210, success: true, createdAt: new Date(now.getTime() - 2 * HOUR) },
    { provider: "openrouter", model: "qwen/qwen3.8-27b:free", tokensIn: 300, tokensOut: 80, latencyMs: 6400, success: false, createdAt: new Date(now.getTime() - 8 * HOUR) },
    { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", tokensIn: 520, tokensOut: 480, latencyMs: 990, success: true, createdAt: new Date(now.getTime() - 1 * DAY) },
  ];
  const logCount = await prisma.usageLog.count({
    where: { userId: DEV_SEED_USER_ID },
  });
  // Keep the sample bounded — replace rather than append forever.
  if (logCount > 8) {
    await prisma.usageLog.deleteMany({ where: { userId: DEV_SEED_USER_ID } });
  }
  await prisma.usageLog.createMany({
    data: logs.map((l) => ({ userId: DEV_SEED_USER_ID, ...l })),
  });
  const usageLogCount = await prisma.usageLog.count({
    where: { userId: DEV_SEED_USER_ID },
  });

  // --- Workspace + owner membership (dev-user is the owner) ---
  // The workspaces tables were added to schema.prisma after some dev databases
  // were last provisioned. If they're missing (Prisma P2021), degrade gracefully
  // — conversations/quota still seed — and report workspace: null so callers
  // (E2E, UI) know not to expect it. Run `npx prisma db push` to enable it.
  let workspace: SeedSummary["workspace"] = null;
  try {
    await prisma.workspace.upsert({
      where: { id: SEED_WORKSPACE_ID },
      update: { name: SEED_WORKSPACE_NAME, ownerId: DEV_SEED_USER_ID },
      create: {
        id: SEED_WORKSPACE_ID,
        name: SEED_WORKSPACE_NAME,
        ownerId: DEV_SEED_USER_ID,
      },
    });
    await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: { workspaceId: SEED_WORKSPACE_ID, userId: DEV_SEED_USER_ID },
      },
      update: { role: "owner" },
      create: {
        workspaceId: SEED_WORKSPACE_ID,
        userId: DEV_SEED_USER_ID,
        role: "owner",
      },
    });
    workspace = { id: SEED_WORKSPACE_ID, name: SEED_WORKSPACE_NAME, role: "owner" };
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2021") throw error;
    console.warn("[Dev seed] workspaces tables missing in this database — skipping workspace seed (run `npx prisma db push`).");
  }

  return {
    ok: true,
    conversations: convos.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c.messages.length,
    })),
    workspace,
    quota: { requestsToday: quota.requestsToday, dailyLimit: quota.dailyLimit, tier: quota.tier },
    usageLogs: usageLogCount,
  };
}
