import { Page, Locator } from "playwright/test";

// Markers in the MOCK_AI reply (see src/lib/mock-ai.ts). The reply starts
// with MOCK_BEGIN and only ends with MOCK_END, so tests can distinguish a
// completed reply from one that was cut off by Stop.
export const MOCK_BEGIN = "MOCK_BEGIN";
export const MOCK_END = "MOCK_END";

/**
 * Every fresh browser context is a "first visit", so the app's BootGate
 * splash overlay hides the page until it finishes or is skipped. Mark the
 * user as a returning visitor before any script runs to bypass the splash
 * deterministically (this suite isn't testing the splash).
 */
export async function markAsReturningVisitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("orplex-visited", "1");
    } catch {
      /* storage unavailable */
    }
  });
}

/**
 * Route /api/chat through the dev-only keyless mock provider by tagging the
 * request with `x-mock-ai: 1`. Needed when the suite reuses an already-
 * running dev server (started without MOCK_AI=1); harmless on a dedicated
 * MOCK_AI server. Real /api/chat requests are passed through untouched.
 */
export async function tagChatRequestsWithMock(page: Page): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), "x-mock-ai": "1" },
    });
  });
}

/** Prepare a page for chat flows: skip the boot splash, enable the mock. */
export async function preparePage(page: Page): Promise<void> {
  await markAsReturningVisitor(page);
  await tagChatRequestsWithMock(page);
}

/** Log in through the dev session bypass API, then land on the chat page. */
export async function loginViaApi(page: Page): Promise<void> {
  await preparePage(page);
  const res = await page.request.get("/api/dev/session?action=login");
  if (!res.ok()) {
    throw new Error(`Dev login failed (${res.status()}): ${(await res.text()).slice(0, 200)}`);
  }
  await page.goto("/");
  // Chat input only exists behind the auth gate on the real chat page — its
  // presence proves the middleware accepted the dev session cookie.
  await page.getByLabel("Chat message").waitFor({ state: "visible", timeout: 60_000 });
}

/** Log in by clicking the "Continue as Dev User" button on the sign-in page. */
export async function loginViaUi(page: Page): Promise<void> {
  await preparePage(page);
  await page.goto("/auth/signin");
  const devButton = page.getByRole("button", { name: "Continue as Dev User" });
  await devButton.waitFor({ state: "visible", timeout: 60_000 });
  await devButton.click();
  await page.getByLabel("Chat message").waitFor({ state: "visible", timeout: 60_000 });
}

/** Type a prompt and press Enter to send it. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Chat message");
  await box.fill(text);
  await box.press("Enter");
}

export const userBubbles = (page: Page) => page.locator(".msg-user .msg-bubble");
export const assistantBubbles = (page: Page) => page.locator(".msg-assistant .msg-bubble");
export const stopButton = (page: Page) => page.getByLabel("Stop generation");
export const sendButton = (page: Page) => page.getByLabel("Send message");

/** Count occurrences of `needle` in a locator's combined text content. */
export async function countOccurrences(locator: Locator, needle: string): Promise<number> {
  const text = (await locator.allTextContents()).join("\n");
  return text.split(needle).length - 1;
}
