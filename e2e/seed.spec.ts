import { test, expect } from "playwright/test";
import { loginViaApi } from "./helpers";

test("dev seed populates conversations, quota usage, and a workspace", async ({ page }) => {
  await loginViaApi(page);

  // Seed sample data for the dev user (idempotent — safe to re-run).
  const seedRes = await page.request.get("/api/dev/session?action=seed");
  expect(seedRes.ok()).toBeTruthy();
  const seed = await seedRes.json();
  expect(seed.ok).toBe(true);
  expect(seed.conversations.length).toBeGreaterThanOrEqual(3);

  // Reload the app so the sidebar conversation list and quota meter refetch.
  await page.goto("/");

  // NON-EMPTY quota: the meter shows seeded usage, not 0/50.
  await expect(page.getByText("12/50 requests today")).toBeVisible();

  // NON-EMPTY history: the newest seeded conversation is in "Recent Chats"
  // and opens with its messages rendered.
  const convButton = page.getByRole("button", { name: "Bakery landing page — first pass" });
  await expect(convButton).toBeVisible();
  await convButton.click();
  await expect(page).toHaveURL(/\?c=seed-conv-landing/);
  await expect(page.getByText("Golden Crumb").first()).toBeVisible();
  await expect(page.getByText("(555) 010-2233").first()).toBeVisible();

  // The two older seeded conversations exist server-side too (sidebar only
  // shows the top five, so verify through the list API).
  const listRes = await page.request.get("/api/conversations");
  const list = await listRes.json();
  const titles = list.conversations.map((c: { title: string }) => c.title);
  expect(titles).toContain("Fix flaky E2E timeout in CI");
  expect(titles).toContain("Dark mode contrast audit");

  // NON-EMPTY workspace: dev-user owns the seeded workspace. Only enforced
  // when the dev DB has the workspaces tables (added to the schema after some
  // databases were last provisioned) — seed returns workspace: null otherwise.
  if (seed.workspace) {
    expect(seed.workspace.name).toBe("Acme Sample Workspace");
    const wsRes = await page.request.get("/api/workspace");
    expect(wsRes.ok()).toBeTruthy();
    const ws = await wsRes.json();
    expect(ws.workspaces.some((w: { name: string }) => w.name === "Acme Sample Workspace")).toBe(true);
  }
});
