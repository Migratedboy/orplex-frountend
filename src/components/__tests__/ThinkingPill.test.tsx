import { fireEvent, render, screen } from "@testing-library/react";
import ThinkingPill from "../ThinkingPill";

describe("ThinkingPill", () => {
  it("can expand before the first reasoning token arrives and keep open as it streams", () => {
    const { rerender } = render(<ThinkingPill done={false} />);
    const button = screen.getByRole("button", { name: /thinking/i });

    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Waiting for reasoning to stream…")).toBeInTheDocument();

    rerender(<ThinkingPill done={false} reasoning="Checking the available options." />);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Checking the available options\./)).toBeInTheDocument();
  });
});
