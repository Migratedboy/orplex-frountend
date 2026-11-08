// The chat run tail must show the DotGridLoader pulse while a turn is live and
// the plain outcome glyph once the turn is over.
//
// Three things are pinned here, because all three were the point of the swap:
//   1. the live phase renders the dot grid (9 cells), NOT the old spinning
//      `progress_activity` glyph;
//   2. a terminal phase renders the outcome glyph and NO loader — a pulsing
//      loader during "done" would claim the run is still going;
//   3. the loader is shown during "thinking" as well, so the reader always has
//      a visible "still running" signal under the last message.
// The dot grid is also decorative: the run-tail is itself the live region, so
// the grid must stay out of the accessibility tree.

import { render, screen } from "@testing-library/react";
import MessageList from "../MessageList";
import type { RunPhase } from "@/lib/background-chat";

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

// The bubble renderers are irrelevant to what this test asserts (the run tail),
// and MessageContent -> MarkdownRenderer drags in `import.meta.url`, which
// ts-jest cannot emit as CommonJS.
jest.mock("../MessageContent", () => ({
  __esModule: true,
  default: ({ runLive }: { runLive?: boolean }) =>
    runLive ? <div data-testid="live-message-activity" /> : null,
}));
jest.mock("../ThinkingPill", () => ({ __esModule: true, default: () => null }));
jest.mock("../ToolCallDisplay", () => ({ __esModule: true, default: () => null }));

function renderTail(phase: RunPhase, label = "") {
  return render(
    <MessageList
      messages={[]}
      agentEvents={[]}
      agentRunning={false}
      runPhase={phase}
      runLabel={label}
    />
  );
}

describe("MessageList — run tail loader", () => {
  it("renders the dot-grid loader while the turn is live", () => {
    const { container } = renderTail("running_tool", "Working…");
    const dot = container.querySelector(".run-tail-dot");
    expect(dot).toBeTruthy();
    expect(dot?.querySelectorAll("i")).toHaveLength(9);
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("drops the old spinning glyph from the live tail", () => {
    const { container } = renderTail("streaming");
    expect(container.querySelector(".run-tail .ms-spin")).toBeNull();
    expect(container.querySelector(".run-tail-dot")).toBeTruthy();
  });

  it("keeps the decorative grid out of the accessibility tree", () => {
    const { container } = renderTail("running_tool");
    expect(container.querySelector(".run-tail-dot")?.getAttribute("aria-hidden")).toBe("true");
    // the tail itself remains the live region
    expect(container.querySelector(".run-tail")?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the outcome glyph, not a loader, on a terminal phase", () => {
    const { container } = renderTail("done");
    expect(container.querySelector(".run-tail-dot")).toBeNull();
    expect(container.querySelector(".run-tail-icon")?.textContent).toBe("check");
  });

  it("shows the error glyph on an error phase", () => {
    const { container } = renderTail("error");
    expect(container.querySelector(".run-tail-dot")).toBeNull();
    expect(container.querySelector(".run-tail-icon")?.textContent).toBe("error");
  });

  it("renders the loader during THINKING too — the reader must see it is running", () => {
    const { container } = renderTail("thinking");
    const dot = container.querySelector(".run-tail-dot");
    expect(dot).toBeTruthy();
    expect(dot?.querySelectorAll("i")).toHaveLength(9);
  });

  it("shows the grid ALONE during thinking — the Thinking block already says it", () => {
    // The Thinking block inside the bubble spells out "Thinking" with its own
    // elapsed timer; repeating that next to the grid is noise. The reference
    // shows the grid standing on its own line.
    const { container } = renderTail("thinking", "Thinking…");
    expect(container.querySelector(".run-tail-dot")).toBeTruthy();
    expect(container.querySelector(".run-tail-label")).toBeNull();
  });

  it("still shows a REAL status detail during thinking", () => {
    const { container } = renderTail("thinking", "Reading src/app/page.tsx…");
    expect(container.querySelector(".run-tail-dot")).toBeTruthy();
    expect(screen.getByText("Reading src/app/page.tsx…")).toBeTruthy();
  });

  it("renders no tail at all for idle", () => {
    expect(renderTail("idle").container.querySelector(".run-tail")).toBeNull();
  });

  it("renders the live message activity immediately while run startup is pending", () => {
    render(
      <MessageList
        messages={[{ role: "assistant", content: "", time: "21:00" }]}
        agentEvents={[]}
        agentRunning={false}
        runActive
        runPhase="idle"
      />
    );

    expect(screen.getByTestId("live-message-activity")).toBeInTheDocument();
  });
});
