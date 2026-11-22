import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import ContextRing from "@/components/ContextRing";
import { publishContextSnapshot, resetContextSnapshot } from "@/lib/context-snapshot";

const usage = (total: number, limit: number, extra: Record<string, unknown> = {}) => ({
  success: true,
  usage: {
    limit,
    limitEstimated: false,
    resolvedModel: "openrouter/free",
    source: "estimate",
    total,
    avgMessage: 1000,
    segments: [
      { key: "system", label: "System prompt", tokens: Math.round(total * 0.1) },
      { key: "tools", label: "Tools", tokens: Math.round(total * 0.1) },
      { key: "files", label: "Files", tokens: Math.round(total * 0.2) },
      { key: "messages", label: "Messages", tokens: total - Math.round(total * 0.4) },
    ],
    ...extra,
  },
});

const calls: unknown[] = [];
let nextBody: unknown = usage(500, 1000);

beforeEach(() => {
  calls.length = 0;
  nextBody = usage(500, 1000);
  resetContextSnapshot();
  publishContextSnapshot({
    conversationId: "c1",
    messages: [{ role: "user", content: "hello" }],
    files: [],
    mentions: [],
  });
  window.fetch = jest.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => nextBody } as unknown as Response;
  }) as unknown as typeof fetch;
});

const ring = () => document.querySelector(".ctx-ring") as HTMLButtonElement;

test("measures the real request through /api/agent/context-usage", async () => {
  render(<ContextRing model="openrouter/free" mode="code" effort="High" draft="write tests" />);
  await waitFor(() => expect(ring().getAttribute("aria-label")).toBe("Context window 50% full"));
  const body = calls.at(-1) as Record<string, unknown>;
  expect(body.model).toBe("openrouter/free");
  expect(body.mode).toBe("code");
  expect(body.effort).toBe("High");
  expect(body.draft).toBe("write tests");
  expect(body.conversationId).toBe("c1");
  expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  // Four real segments are drawn, none of them invented.
  expect(document.querySelectorAll(".ctx-seg")).toHaveLength(4);
});

test("warn at 70% and crit at 90%, with the actions that only make sense there", async () => {
  nextBody = usage(750, 1000);
  render(<ContextRing model="openrouter/free" mode="code" draft="" />);
  await waitFor(() => expect(document.querySelector(".ctx-wrap")?.getAttribute("data-state")).toBe("warn"));
  // The actions live in the popover, which opens on hover/focus.
  fireEvent.mouseOver(ring());
  await waitFor(() => expect(screen.getByRole("button", { name: /compact/i })).toBeTruthy());

  nextBody = usage(950, 1000);
  await act(async () => {
    window.dispatchEvent(new Event("orplex:chat-sent"));
  });
  await waitFor(() => expect(document.querySelector(".ctx-wrap")?.getAttribute("data-state")).toBe("crit"));
  expect(ring().getAttribute("aria-label")).toBe("Context window 95% full");
  expect(screen.getByRole("button", { name: /new chat/i })).toBeTruthy();
});

test("under 70% there is nothing to compact, so no action buttons", async () => {
  render(<ContextRing model="openrouter/free" mode="code" draft="" />);
  await waitFor(() => expect(document.querySelector(".ctx-pct")?.textContent).toContain("50"));
  expect(screen.queryByRole("button", { name: /compact/i })).toBeNull();
});

test("the buttons dispatch the real events the composer listens for", async () => {
  nextBody = usage(950, 1000);
  const seen: string[] = [];
  const onCompact = () => seen.push("compact");
  const onNew = () => seen.push("new");
  window.addEventListener("ctx:compact", onCompact);
  window.addEventListener("ctx:new", onNew);
  render(<ContextRing model="openrouter/free" mode="code" draft="" />);
  fireEvent.mouseOver(ring());
  await waitFor(() => expect(screen.getByRole("button", { name: /compact/i })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /compact/i }));
  fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
  window.removeEventListener("ctx:compact", onCompact);
  window.removeEventListener("ctx:new", onNew);
  expect(seen).toEqual(["compact", "new"]);
});

test("an estimated window is labelled estimated instead of pretending to be exact", async () => {
  nextBody = usage(100, 32_000, { limitEstimated: true, resolvedModel: "nope/not-a-model" });
  render(<ContextRing model="nope/not-a-model" mode="code" draft="" />);
  await waitFor(() => expect(document.querySelector(".ctx-meta")?.textContent).toContain("estimated"));
  // Estimated numbers are prefixed so nobody reads them as provider counts.
  expect(document.querySelector(".ctx-rows")?.textContent).toContain("~");
});

test("a provider-reported count drops the estimate marker", async () => {
  nextBody = usage(400, 1000, { source: "provider" });
  render(<ContextRing model="openrouter/free" mode="code" draft="" />);
  await waitFor(() => expect(document.querySelector(".ctx-pct")?.textContent).toContain("40"));
  const rows = document.querySelector(".ctx-rows")?.textContent ?? "";
  expect(rows).not.toContain("~");
});
