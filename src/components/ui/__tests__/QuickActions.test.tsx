/**
 * QuickActions.test.tsx — the follow-up chip bar's three states.
 *
 * The wave-loader state it pins: while /api/chat/suggestions is generating,
 * the five chip slots must render as non-interactive skeleton pills with a
 * three-dot wave (qa-dot-wave) instead of text — then swap to the real
 * suggestions. Regression guard: a loader that renders as text chips, is
 * clickable mid-load, or blanks the bar when generation fails.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import QuickActions from "../QuickActions";

const onAction = jest.fn();

describe("QuickActions", () => {
  it("loading → five skeleton pills with 3-dot waves, no text, not clickable", () => {
    const { container } = render(
      <QuickActions onAction={onAction} hasFiles={true} isRunning={false} loadingSuggestions={true} />
    );
    const bars = container.querySelector(".qa-bar");
    expect(bars?.getAttribute("aria-busy")).toBe("true");
    const loaders = container.querySelectorAll(".qa-chip--loading");
    expect(loaders.length).toBe(5);
    // Every slot carries exactly three wave dots.
    loaders.forEach((chip) => {
      expect(chip.querySelectorAll(".qa-dot-wave > span").length).toBe(3);
      // No text label leaks into the skeleton — only the dot wave.
      expect(chip.textContent?.trim()).toBe("");
    });
    // Skeleton spans are never <button>s: nothing is clickable mid-generate.
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("loading with STALE suggestions still shows the loader (not the old text)", () => {
    // While a fresh batch generates, previous chips must not masquerade as
    // new ones — the loader state wins over the stale suggestions prop.
    const { container } = render(
      <QuickActions
        onAction={onAction}
        hasFiles={true}
        isRunning={false}
        suggestions={["Old suggestion"]}
        loadingSuggestions={true}
      />
    );
    expect(container.querySelectorAll(".qa-chip--loading").length).toBe(5);
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("loaded → real AI chips render as buttons and fire onAction", () => {
    const { container } = render(
      <QuickActions
        onAction={onAction}
        hasFiles={true}
        isRunning={false}
        suggestions={["Fix the store", "Add tests"]}
        loadingSuggestions={false}
      />
    );
    expect(container.querySelectorAll(".qa-chip--loading").length).toBe(0);
    const chips = screen.getAllByText(/Fix the store|Add tests/);
    expect(chips.length).toBe(2);
    fireEvent.click(screen.getByText("Add tests"));
    expect(onAction).toHaveBeenCalledWith("Add tests");
  });

  it("generation FAILED (loading false, suggestions empty) → static chips return", () => {
    const { container } = render(
      <QuickActions onAction={onAction} hasFiles={true} isRunning={false} loadingSuggestions={false} />
    );
    // The bar never blanks: the static utility chips are back.
    expect(screen.getByText("Fix bugs")).toBeTruthy();
    expect(container.querySelectorAll(".qa-chip--loading").length).toBe(0);
  });

  it("isRunning → the whole bar hides (including any mid-generate loader)", () => {
    const { container } = render(
      <QuickActions onAction={onAction} hasFiles={true} isRunning={true} loadingSuggestions={true} />
    );
    expect(container.querySelector(".qa-bar")).toBeNull();
  });
});
