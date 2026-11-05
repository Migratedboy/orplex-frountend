// The chat canvas backdrop (the WebGL gradient-ASCII field).
//
// The contract pinned here:
//   1. the canvas NEVER eats clicks — it is artwork BEHIND the conversation,
//      not a layer on top of it (pointer-events: none);
//   2. the base colour comes from the app's --ob-base token, so the chat
//      column meets the sidebar and the top bar without a seam;
//   3. `fixed={false}` fills the chat column instead of the whole viewport;
//   4. the palette follows the APP's theme class, not the OS preference —
//      Orplex has no "system" theme, so a light app must never get a dark
//      canvas behind it.
//
// jsdom has no WebGL2, so the GL pipeline simply does not start here; these
// tests pin the DOM contract, not the shader.

import { render, act } from "@testing-library/react";
import OrplexBackground from "../OrplexBackground";

function wrapperOf(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild as HTMLElement;
  return el;
}

describe("OrplexBackground — the chat backdrop", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("never intercepts a click — it is behind the conversation", () => {
    const { container } = render(<OrplexBackground fixed={false} />);
    const style = wrapperOf(container).style;
    expect(style.pointerEvents).toBe("none");
    expect(style.zIndex).toBe("0");
  });

  it("fills its parent when fixed={false}, and the viewport otherwise", () => {
    const { container: inFlow } = render(<OrplexBackground fixed={false} />);
    expect(wrapperOf(inFlow).style.position).toBe("absolute");
    expect(wrapperOf(inFlow).style.inset).toBe("0px");

    const { container: pinned } = render(<OrplexBackground />);
    expect(wrapperOf(pinned).style.position).toBe("fixed");
  });

  it("takes the base colour from the app's --ob-base token", () => {
    const { container } = render(<OrplexBackground fixed={false} />);
    // The token owns the surface; the palette value is only the fallback.
    expect(wrapperOf(container).style.background).toContain("var(--ob-base");
  });

  it("follows the app's theme class, not the OS preference", () => {
    document.documentElement.classList.add("dark");
    const { container } = render(<OrplexBackground fixed={false} />);
    // The dark palette's fallback is in the custom property.
    expect(wrapperOf(container).style.background).toContain("#0d0a08");

    act(() => {
      document.documentElement.classList.remove("dark");
    });
    expect(wrapperOf(container).style.background).toContain("#fbf6ef");
  });

  it("keeps the artwork out of the accessibility tree", () => {
    const { container } = render(<OrplexBackground fixed={false} />);
    expect(wrapperOf(container).getAttribute("aria-hidden")).toBe("true");
    // ... and it draws into a canvas, never into the DOM as text.
    expect(container.querySelector("canvas")).toBeTruthy();
    expect(container.textContent).toBe("");
  });
});
