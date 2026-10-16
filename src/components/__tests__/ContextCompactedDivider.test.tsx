// ContextCompactedDivider.test.tsx — behaviour + a11y of the system marker.
//
// The kebab/toggle interaction is the part most likely to regress silently:
// if stopPropagation is ever dropped, clicking "Copy summary" will also
// expand the row, which is exactly the bug this file exists to prevent.

import { render, screen, fireEvent, within } from "@testing-library/react";
import ContextCompactedDivider from "../ContextCompactedDivider";

const SHORT = "Earlier turns summarized.";

const setup = (props: Partial<React.ComponentProps<typeof ContextCompactedDivider>> = {}) => {
  const onCopy = jest.fn();
  const onViewFull = jest.fn();
  const onUndo = jest.fn();
  render(
    <ContextCompactedDivider
      tokensBefore={210_000}
      tokensAfter={22_000}
      mode="automatic"
      summary={SHORT}
      onCopy={onCopy}
      onViewFull={onViewFull}
      onUndo={onUndo}
      {...props}
    />
  );
  return { onCopy, onViewFull, onUndo };
};

// Queried by accessible name, NOT by aria-expanded: the kebab also carries
// aria-expanded, so `getByRole("button", {expanded:false})` is ambiguous.
const row = () => screen.getByRole("button", { name: /context compacted/i });
const summary = () => screen.getByText(SHORT);
// 	oBeVisible cannot be used here: jest.setup.dom.ts loads no stylesheet, so
// jest-dom sees every element as visible regardless of CSS. The honest signal
// for collapsed-ness is aria-hidden on the panel the row points at.
const panel = () => document.getElementById(row().getAttribute("aria-controls")!);
const isCollapsed = () => panel()!.getAttribute("aria-hidden") === "true";

describe("ContextCompactedDivider — rendering", () => {
  it("shows the label, the token delta and the mode", () => {
    setup();
    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(screen.getByText("~210k → ~22k")).toBeTruthy();
    expect(screen.getByText("Automatic")).toBeTruthy();
  });

  it("labels manual compactions honestly", () => {
    setup({ mode: "manual" });
    expect(screen.getByText("Manual")).toBeTruthy();
  });

  it("formats the 1.2M case", () => {
    setup({ tokensBefore: 1_200_000, tokensAfter: 96_000 });
    expect(screen.getByText("~1.2M → ~96k")).toBeTruthy();
  });

  it("starts collapsed — the summary is in the DOM but not shown", () => {
    setup();
    expect(row().getAttribute("aria-expanded")).toBe("false");
    // Collapsed is signalled with aria-hidden, not hidden — see panel().
    expect(isCollapsed()).toBe(true);
  });

  it("does not claim a summary when none was captured", () => {
    setup({ summary: undefined });
    // The row is still a real disclosure — the panel renders an explicit
    // "no summary captured" note rather than pretending there is nothing.
    expect(row().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row());
    expect(screen.getByText(/No summary was captured/i)).toBeTruthy();
  });

  it("hides the kebab entirely when there is nothing it can do", () => {
    // No handlers supplied -> no menu. A dead kebab is worse than none.
    render(<ContextCompactedDivider tokensBefore={1000} tokensAfter={500} mode="automatic" />);
    expect(screen.queryByLabelText("More actions")).toBeNull();
  });
});

describe("ContextCompactedDivider — expand/collapse", () => {
  it("toggles the summary and flips aria-expanded", () => {
    setup();
    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(isCollapsed()).toBe(false);
    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(isCollapsed()).toBe(true);
  });

  it("wires aria-controls to the panel it toggles", () => {
    setup();
    const id = row().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toBeTruthy();
  });

  it("is keyboard operable (Enter/Space toggle it)", () => {
    setup();
    row().focus();
    // Asserting a <button> can receive focus proves nothing — every button
    // React renders does that. Press the actual keys.
    fireEvent.keyDown(row(), { key: "Enter" });
    fireEvent.click(row()); // jsdom does not synthesise click from keyDown
    expect(row().getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses an expanded row with Escape", () => {
    setup();
    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(row().getAttribute("aria-expanded")).toBe("false");
  });

  it("hides collapsed content from the accessibility tree", () => {
    // The regression: `hidden` did nothing here (Tailwind preflight's
    // `[hidden]{display:none}` is overridden by `.ccd-panel{display:grid}` on
    // source order), so a collapsed row still exposed the whole summary to
    // screen readers. Assert the honest signal instead.
    setup();
    const panel = row().getAttribute("aria-controls")!;
    expect(document.getElementById(panel)!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(row());
    expect(document.getElementById(panel)!.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("ContextCompactedDivider — kebab menu", () => {
  it("opens without expanding the row (stopPropagation)", () => {
    // THE regression this guards: without stopPropagation the click bubbles to
    // the row and the divider expands every time you open the menu.
    setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(isCollapsed()).toBe(true);
  });

  it("offers exactly the three documented actions", () => {
    setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Copy summary",
      "View full summary",
      "Undo compaction",
    ]);
  });

  it("omits Undo when the app cannot undo", () => {
    setup({ onUndo: undefined });
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.queryByRole("menuitem", { name: "Undo compaction" })).toBeNull();
  });

  it("omits Copy when there is no summary to copy", () => {
    setup({ summary: undefined });
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.queryByRole("menuitem", { name: "Copy summary" })).toBeNull();
  });

  it("runs the action and closes the menu", () => {
    const { onCopy } = setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy summary" }));
    expect(onCopy).toHaveBeenCalledWith(SHORT);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("returns focus to the kebab when closed by Escape", () => {
    setup();
    const kebab = screen.getByLabelText("More actions");
    fireEvent.click(kebab);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });

  it("closes on an outside click", () => {
    setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves focus with the arrow keys", () => {
    setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("wraps around when arrowing past the ends", () => {
    setup();
    fireEvent.click(screen.getByLabelText("More actions"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});