/**
 * The model menu keys each row by model id, so two rows with the same id
 * render as two children with one React key. React reports that as a console
 * error and may drop/re-create rows instead of updating them.
 *
 * That shipped once: `nvidia/nemotron-3-ultra-550b-a55b:free` was listed
 * twice in the curated defaults, and the picker threw
 * "Encountered two children with the same key" on every open.
 *
 * The menu now collapses duplicate ids itself, so no feed it receives can
 * produce the warning.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import PromptBar, { type PromptBarModel } from "../PromptBar";

const DUPLICATED: PromptBarModel[] = [
  { key: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", tag: "OpenRouter", detail: "free · 1M" },
  { key: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", tag: "OpenRouter", detail: "free · 262K" },
  { key: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", tag: "OpenRouter", detail: "free · 262K" },
];

function openModelMenu() {
  render(<PromptBar models={DUPLICATED} defaultModel={DUPLICATED[0].key} />);
  // The composer is focused in the real app; the picker's onFocus handler
  // closes the menus, so the click below has to start from that state.
  screen.getByLabelText("Prompt").focus();
  fireEvent.click(screen.getByLabelText("Choose model"));
}

describe("model picker rows", () => {
  let errors: string[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("renders duplicate model ids without a React duplicate-key warning", () => {
    openModelMenu();
    const warnings = errors.filter((e) => e.includes("same key"));
    expect(warnings).toEqual([]);
  });

  it("shows each model id once", () => {
    openModelMenu();
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names.filter((n) => n.includes("Nemotron 3 Ultra"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("Gemma 4 31B"))).toHaveLength(1);
  });

  it("renders every distinct model", () => {
    openModelMenu();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
