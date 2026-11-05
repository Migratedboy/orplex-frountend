// The agent reasoning thread (ThoughtThread).
//
// The contract pinned here:
//   1. one hook per turn — the thread grows with the transcript instead of
//      restarting, and a reloaded turn is hydrated finished (never "active");
//   2. the mocked run from the brief: one think step, two tool steps, a
//      failing gate followed by a repair, a loop-breaker stop, a final result;
//   3. the tool rows carry the tool-call glyph and tick, so the thread and
//      the tool UI are one language;
//   4. finished rows fold to one line and reopen on click, from the keyboard;
//   5. pure reasoning rows ("[THINKING]") render as the ThinkingPill with a
//      collapsible reasoning panel; tools/gates/result stay in the thread;
//   6. prefers-reduced-motion is respected.

import { render, screen, fireEvent } from "@testing-library/react";
import ThoughtThread from "../ThoughtThread";
import { thoughtLineCss } from "../ThoughtLine";
import { parseContent } from "@/lib/message-content";

const THINK = "[THINKING]The retry helper should live in one place, not in the fetch wrapper.[/THINKING]";
const TOOL_1 = "running [grep -rn fetchWithRetry src/]";
const TOOL_1_DONE = "[OK] Command completed: 4 call sites";
const TOOL_2 = "running [npm test]";
const TOOL_2_FAIL = "[FAIL] Command failed: 1 suite failed";
const GATE = "**Verifying changes.** typecheck round 1/2";
const GATE_FAIL = "**Verification failed** - 3 error(s), repairing.";
const REPAIR = "**Swarm found issues - repairing.**";
const LOOP_STOP = "*[Loop detected - the same test command ran twice. Forcing a strategy change.]*";
const ANSWER = "All retry logic now lives in src/net/retry.js and every suite passes.";

const PARTIAL = [THINK, "", TOOL_1].join("\n");
const FULL = [
  THINK,
  "",
  TOOL_1,
  TOOL_1_DONE,
  "",
  TOOL_2,
  TOOL_2_FAIL,
  "",
  GATE,
  GATE_FAIL,
  "",
  REPAIR,
  "",
  LOOP_STOP,
  "",
  ANSWER,
].join("\n");

function renderThread(content: string, runLive = false) {
  return render(<ThoughtThread segments={parseContent(content)} runLive={runLive} />);
}

const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".tl-item"));

describe("ThoughtThread — the mocked run", () => {
  it("keeps reasoning OUT of the thread rows — it renders as the pill", () => {
    const { container } = renderThread(FULL);
    const texts = rows(container).map((r) => r.querySelector(".tl-text")?.textContent);
    // tools, tools, gate, repair, loop breaker, result — the thinking step
    // belongs to the ThinkingPill, not the thread.
    expect(texts).toEqual([
      "Run grep -rn fetchWithRetry src/",
      "Run npm test",
      "Gate: typecheck",
      "Repair: review findings",
      "Loop breaker: the same test command ran twice. Forcing a strategy change.",
      "All retry logic now lives in src/net/retry.js and every suite passes.",
    ]);
  });

  it("marks the failed tool and the failed gate as errors", () => {
    const { container } = renderThread(FULL);
    const states = rows(container).map((r) => r.getAttribute("data-status"));
    // think pill (not a row) · done · error · error · done · error · done
    expect(states).toEqual(["done", "error", "error", "done", "error", "done"]);
  });

  it("puts the tool-call glyph in the node", () => {
    const { container } = renderThread(FULL);
    const glyphs = rows(container).map((r) => r.querySelector(".tl-node .ms")?.textContent);
    // run · run · gate(run) · repair · loop · result
    expect(glyphs).toEqual(["smart_display", "smart_display", "smart_display", "build", "loop", undefined]);
  });

  it("keeps the tool output in the row's expandable body", () => {
    const { container } = renderThread(FULL);
    const bodies = rows(container).map((r) => r.querySelector(".tl-detail-text")?.textContent || "");
    expect(bodies[0]).toContain("grep -rn fetchWithRetry src/");
    expect(bodies[0]).toContain("Command completed: 4 call sites");
    expect(bodies[1]).toContain("Command failed: 1 suite failed");
  });

  it("renders the reasoning as a collapsible ThinkingPill", () => {
    const { container } = renderThread(FULL);
    const pill = container.querySelector(".tp-pill")!;
    // The reasoning lives inside the pill's panel region, collapsed by default
    // (thinking finished → auto-collapse; the user can open it).
    expect(container.querySelector(".tp")).not.toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Thought");
    // Open it — the reasoning text appears in the panel.
    fireEvent.click(pill);
    const panel = container.querySelector(".tp-panel")!;
    expect(panel.getAttribute("data-open")).toBe("true");
    expect(container.querySelector(".tp-reason")?.textContent).toContain(
      "The retry helper should live in one place, not in the fetch wrapper."
    );
  });

  it("shows no pill and no thread at all when the turn has no steps", () => {
    const { container } = renderThread("Just a plain answer with no tools.");
    expect(container.querySelector(".tl")).toBeNull();
    expect(container.querySelector(".tp")).toBeNull();
  });
});

describe("ThoughtThread — live turn", () => {
  it("keeps the running tool active while the turn is live", () => {
    const { container } = renderThread(PARTIAL, true);
    const active = rows(container).filter((r) => r.getAttribute("data-status") === "active");
    expect(active).toHaveLength(1);
    expect(active[0].querySelector(".tl-text")?.textContent).toBe("Run grep -rn fetchWithRetry src/");
  });

  it("never leaves a stale active row after a reload", () => {
    // The same transcript, but the turn is over (the page was reloaded).
    const { container } = renderThread(PARTIAL, false);
    expect(rows(container).every((r) => r.getAttribute("data-status") !== "active")).toBe(true);
  });

  it("grows with the transcript instead of restarting it", () => {
    const { container, rerender } = renderThread(PARTIAL, true);
    expect(rows(container)).toHaveLength(1);

    rerender(<ThoughtThread segments={parseContent(FULL)} runLive={true} />);
    expect(rows(container).length).toBeGreaterThan(1);
    // The first row survived the update — the hook was not re-created.
    expect(rows(container)[0].querySelector(".tl-text")?.textContent).toContain("Run grep");
  });

  it("adds the result row when the turn ends", () => {
    const { container, rerender } = renderThread(PARTIAL, true);
    expect(container.textContent).not.toContain("All retry logic now lives");
    rerender(<ThoughtThread segments={parseContent(FULL)} runLive={false} />);
    expect(container.textContent).toContain("All retry logic now lives");
  });

  it("is in thinking state while the model streams reasoning live", () => {
    // Reasoning is the LAST thing that landed: the model is mid-thought.
    const LIVE_THINK = "[THINKING]Comparing the two retry strategies…[/THINKING]";
    const { container } = renderThread(LIVE_THINK, true);
    // Live reasoning: the pill reads "Thinking…" and streams the text in view.
    const pill = container.querySelector(".tp-pill")!;
    expect(pill.querySelector(".tp-text")?.textContent).toBe("Thinking…");
    expect(container.querySelector(".tp-reason")?.textContent).toContain("Comparing the two retry strategies");
    // And once the turn is over, it collapses into the done pill.
    const { container: done } = renderThread(LIVE_THINK, false);
    expect(done.querySelector(".tp-pill .tp-text")?.textContent).toBe("Thought");
  });
});

describe("ThoughtThread — accessibility", () => {
  it("folds a finished row to one line and reopens it on click", () => {
    const { container } = renderThread(FULL);
    const row = rows(container)[0];
    const head = row.querySelector<HTMLButtonElement>(".tl-head")!;
    const detail = row.querySelector<HTMLElement>(".tl-detail")!;

    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(detail.hasAttribute("data-open")).toBe(false);

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector(".tl-detail")?.hasAttribute("data-open")).toBe(true);
  });

  it("exposes every expandable row as a real button (keyboard reachable)", () => {
    const { container } = renderThread(FULL);
    const heads = Array.from(container.querySelectorAll<HTMLButtonElement>(".tl-head"));
    expect(heads.length).toBe(rows(container).length);
    heads.forEach((h) => expect(h.tagName).toBe("BUTTON"));
    // A row without a body has nothing to open, so it is disabled.
    const resultHead = heads[heads.length - 1];
    expect(resultHead.disabled).toBe(true);
  });

  it("labels the thread as a log for assistive tech", () => {
    renderThread(FULL);
    const log = screen.getByRole("log", { name: "Agent reasoning thread" });
    expect(log).toBeTruthy();
  });

  it("respects prefers-reduced-motion", () => {
    expect(thoughtLineCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(thoughtLineCss).toContain("animation: none !important");
  });
});
