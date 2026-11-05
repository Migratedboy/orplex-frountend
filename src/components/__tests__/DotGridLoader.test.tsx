// DotGridLoader — the 3x3 dot-grid loader that replaced the spinning glyph in
// the chat run tail.
//
// The component itself is the user's own file (src/components/DotGridLoader.tsx),
// so these tests pin only the CONTRACT the chat depends on: nine cells in a
// 3x3 grid, the hairline gap derived from the size, and an accessible name
// when the loader stands on its own.

import { render } from "@testing-library/react";
import DotGridLoader from "../DotGridLoader";

describe("DotGridLoader", () => {
  it("renders a 3x3 grid of 9 cells", () => {
    const { container } = render(<DotGridLoader />);
    const grid = container.querySelector("div") as HTMLElement;
    expect(grid).toBeTruthy();
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 1fr)");
    expect(grid.style.gridTemplateRows).toBe("repeat(3, 1fr)");
    expect(grid.querySelectorAll("i")).toHaveLength(9);
  });

  it("sizes the grid and derives the hairline gap from the size", () => {
    const { container } = render(<DotGridLoader size={33} />);
    const grid = container.querySelector("div") as HTMLElement;
    expect(grid.style.width).toBe("33px");
    expect(grid.style.height).toBe("33px");
    // gap defaults to ~7% of the size, rounded (33 * 0.07 = 2.31 -> 2)
    expect(grid.style.gap).toBe("2px");
  });

  it("honours an explicit gap", () => {
    const { container } = render(<DotGridLoader size={33} gap={5} />);
    const grid = container.querySelector("div") as HTMLElement;
    expect(grid.style.gap).toBe("5px");
  });

  it("exposes an accessible name when it stands alone", () => {
    const { getByRole } = render(<DotGridLoader />);
    expect(getByRole("status").getAttribute("aria-label")).toBe("Loading");
  });

  it("uses the label as the accessible name and renders it as text", () => {
    const { getByRole, getByText } = render(<DotGridLoader label="Thinking…" />);
    expect(getByRole("status").getAttribute("aria-label")).toBe("Thinking…");
    expect(getByText("Thinking…")).toBeTruthy();
  });

  it("puts the className on the grid when bare and on the wrapper when labelled", () => {
    const bare = render(<DotGridLoader className="bare" />);
    const bareEl = bare.container.querySelector(".bare") as HTMLElement;
    expect(bareEl).toBeTruthy();
    // the bare grid IS the classed element — its children are the cells
    expect(bareEl.firstElementChild?.tagName).toBe("I");

    const labelled = render(<DotGridLoader className="wrapped" label="L" />);
    const wrappedEl = labelled.container.querySelector(".wrapped") as HTMLElement;
    expect(wrappedEl).toBeTruthy();
    // the labelled wrapper holds the grid AND the text, so it has no .wrapped grid inside
    expect(wrappedEl.querySelector(".wrapped")).toBeNull();
    expect(wrappedEl.textContent).toContain("L");
  });

  it("renders under prefers-reduced-motion without throwing", () => {
    const spy = jest.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList
    );
    try {
      const { container } = render(<DotGridLoader size={16} />);
      expect(container.querySelectorAll("i")).toHaveLength(9);
    } finally {
      spy.mockRestore();
    }
  });
});
