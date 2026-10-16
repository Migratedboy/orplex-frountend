// jest.setup.dom.ts — browser-ish globals for the `dom` jest project.
//
// Only what React 18 actually needs. Kept minimal on purpose: polyfilling the
// whole browser here would let a component test pass against an environment
// nothing ships, which is worse than not having the test.
import "@testing-library/jest-dom";

// jsdom has no matchMedia; several components (reduced-motion, theme) read it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom does not implement scrollIntoView, which virtual lists call on mount.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}