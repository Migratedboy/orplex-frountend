import { test, expect } from "playwright/test";
import {
  loginViaApi,
  loginViaUi,
  sendPrompt,
  countOccurrences,
  userBubbles,
  assistantBubbles,
  stopButton,
  sendButton,
} from "./helpers";

// NOTE on prompts: keep them free of the worker's "force tool usage" trigger
// words (build/create/make/generate/write/code/develop/implement/set up) so a
// plain "ask" reply always ends after a single streamed turn.

test("dev session bypass logs in through the sign-in page", async ({ page }) => {
  await loginViaUi(page);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("Orplex Agent can make mistakes. Verify important information.")).toBeVisible();
});

test("sending a message streams a reply that completes", async ({ page }) => {
  await loginViaApi(page);
  const prompt = "E2E first message — answer me plainly please";
  await sendPrompt(page, prompt);

  // The user's own message shows up as a bubble.
  await expect(userBubbles(page).last()).toContainText(prompt);

  // The assistant bubble starts streaming and eventually completes.
  const reply = assistantBubbles(page).last();
  await expect(reply).toContainText("MOCK_BEGIN");

  // Streaming is PROGRESSIVE: while the reply is mid-flight, its rendered
  // text keeps growing (regression guard — if per-chunk updates ever stop
  // re-rendering, the whole text would pop in at once and this fails).
  const lenBefore = (await reply.textContent())?.length ?? 0;
  await page.waitForTimeout(800);
  const lenAfter = (await reply.textContent())?.length ?? 0;
  expect(lenAfter).toBeGreaterThan(lenBefore);

  await expect(reply).toContainText("MOCK_END");

  // Agent is no longer running — Stop is gone, Send is back.
  await expect(stopButton(page)).toHaveCount(0);
  await expect(sendButton(page)).toBeVisible();

  // Exactly one reply, emitted once (a single agent turn, no retry loop).
  const replies = assistantBubbles(page);
  await expect(replies).toHaveCount(1);
  expect(await countOccurrences(replies, "MOCK_BEGIN")).toBe(1);
  expect(await countOccurrences(replies, "MOCK_END")).toBe(1);
});

test("Stop mid-stream cuts the reply and a resend completes on a fresh task", async ({ page }) => {
  await loginViaApi(page);
  await sendPrompt(page, "E2E stop me mid stream please");

  const reply = assistantBubbles(page).last();
  // Wait until streaming is visibly underway but the reply has NOT finished.
  await expect(reply).toContainText("MOCK_BEGIN");
  await expect(reply).not.toContainText("MOCK_END");

  // Stop while the mock reply is still ~seconds from completing.
  const stop = stopButton(page);
  await expect(stop).toBeVisible();
  await stop.click();

  // Stop took effect: the running state cleared and the input is usable again.
  await expect(sendButton(page)).toBeVisible();
  await expect(stop).toHaveCount(0);

  // Give a would-be stream tail plenty of time to arrive — nothing may ever
  // complete: the reply's partial content was preserved in the bubble, but
  // MOCK_END (its final token, seconds later) must never appear.
  await page.waitForTimeout(2000);
  const stoppedBubble = assistantBubbles(page).first();
  await expect(stoppedBubble).toContainText("MOCK_BEGIN");
  expect(((await stoppedBubble.textContent()) ?? "")).not.toContain("MOCK_END");
  expect(await countOccurrences(assistantBubbles(page), "MOCK_END")).toBe(0);

  // No failure UI appeared.
  await expect(page.locator(".toast-error")).toHaveCount(0);
  await expect(assistantBubbles(page)).not.toContainText(/Unknown error|Task failed/);

  // Resend: the new reply must complete, proving Stop didn't poison the queue
  // or leave the agent wedged.
  await sendPrompt(page, "E2E message sent after stopping");
  const second = assistantBubbles(page).nth(1);
  await expect(second).toContainText("MOCK_BEGIN");
  await expect(second).toContainText("MOCK_END");

  // The stopped bubble kept only its partial content; exactly one reply (the
  // resend) ever completed.
  expect(((await stoppedBubble.textContent()) ?? "")).not.toContain("MOCK_END");
  expect(await countOccurrences(assistantBubbles(page), "MOCK_END")).toBe(1);
});

test("Stop with a queued prompt clears the queue and tells the user", async ({ page }) => {
  await loginViaApi(page);
  await sendPrompt(page, "E2E queue base message one");

  // Busy window: first reply is mid-stream.
  await expect(assistantBubbles(page).last()).toContainText("MOCK_BEGIN");

  // Send a second prompt while the agent is running — it gets queued.
  await sendPrompt(page, "E2E queued second prompt");
  await expect(page.getByText(/Queued:/)).toBeVisible();
  await expect(page.locator(".queue-indicator")).toContainText("Queue (1)");

  // Stop clears the queue AND surfaces it to the user via a toast.
  await expect(stopButton(page)).toBeVisible();
  await stopButton(page).click();
  await expect(page.getByText(/Stopped — 1 queued prompt cancelled/)).toBeVisible();
  await expect(page.locator(".queue-indicator")).toHaveCount(0);

  // Input is usable again and the queued prompt never became a message.
  await expect(sendButton(page)).toBeVisible();
  await expect(userBubbles(page)).toHaveCount(1);
});

test("End dev session clears the cookie and a fresh login works", async ({ page }) => {
  await loginViaApi(page); // signed in as Dev User

  // The sign-in page is public, so an authenticated tester can reach it.
  await page.goto("/auth/signin");
  const endSession = page.getByRole("button", { name: "End dev session" });
  await expect(endSession).toBeVisible();
  await endSession.click();

  // Confirmation appears after the httpOnly dev cookie was expired.
  await expect(page.getByText(/Dev session ended/)).toBeVisible();

  // The cookie is really gone: the protected chat route now bounces to sign-in.
  await page.goto("/");
  await page.waitForURL(/\/auth\/signin/);
  await expect(page.getByLabel("Chat message")).toHaveCount(0);

  // Log back in as Dev User — a fresh cookie is issued and the app opens.
  await page.getByRole("button", { name: "Continue as Dev User" }).click();
  await page.getByLabel("Chat message").waitFor({ state: "visible", timeout: 60_000 });
  expect(new URL(page.url()).pathname).toBe("/");
});
