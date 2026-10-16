// MessageList compaction rendering — the regression guard for the virtual-list
// gap.
//
// MessageList renders through TWO different paths: a plain map for short
// lists, and <VirtualList> -> RenderableItem once items.length > 20. When the
// compaction divider was only wired into the short path, it rendered in the
// demo and vanished in production — because compaction fires in LONG sessions.
// This test drives both paths explicitly.

import { render, screen } from "@testing-library/react";
import MessageList from "../MessageList";
import type { AgentEvent } from "@/lib/types";

jest.mock("../VirtualList", () => ({
  VirtualList: ({
    items,
    renderItem,
  }: {
    items: Array<{ kind: string }>;
    renderItem: (item: never) => React.ReactNode;
  }) => <div data-testid="virtual-list">{items.map((it, i) => renderItem(it as never))}</div>,
}));

jest.mock("@/lib/api-base", () => ({ apiFetch: jest.fn() }));

// The bubble renderers are irrelevant to what this test asserts (which event
// row is chosen), and MessageContent -> MarkdownRenderer drags in
// `import.meta.url`, which ts-jest cannot emit as CommonJS. Mocking them keeps
// the test focused on the routing decision.
jest.mock("../MessageContent", () => ({ __esModule: true, default: () => null }));
jest.mock("../ThinkingCard", () => ({ __esModule: true, default: () => null }));
jest.mock("../ToolCallDisplay", () => ({ __esModule: true, default: () => null }));

const compaction: AgentEvent = {
  type: "compacted",
  tokensBefore: 210_000,
  tokensAfter: 22_000,
  mode: "automatic",
  summary: "Earlier turns summarized.",
};

const msg = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}`, time: i });

function renderList(events: AgentEvent[], messageCount: number) {
  return render(
    <MessageList
      messages={Array.from({ length: messageCount }, (_, i) => msg(i)) as never}
      agentEvents={events}
      agentRunning={false}
    />
  );
}

describe("MessageList — compaction divider on both render paths", () => {
  it("renders the divider on the SHORT path (< 20 items)", () => {
    renderList([compaction], 5);
    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(screen.getByText("~210k → ~22k")).toBeTruthy();
  });

  it("renders the divider on the VIRTUAL path (> 20 items) — the F2 regression", () => {
    // This is the case that shipped broken: with useVirtual true the rows go
    // through RenderableItem, which had no compaction branch, so the marker
    // returned null and disappeared exactly where compaction actually happens.
    renderList([compaction], 25);
    expect(screen.getByTestId("virtual-list")).toBeTruthy();
    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(screen.getByText("~210k → ~22k")).toBeTruthy();
  });

  it("renders the divider once per event", () => {
    renderList([compaction, compaction], 5);
    expect(screen.getAllByText("Context compacted")).toHaveLength(2);
  });
});