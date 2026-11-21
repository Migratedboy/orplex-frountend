import { fireEvent, render, screen } from "@testing-library/react";
import CommandApprovalCard from "../CommandApprovalCard";
import { initialDecisionState } from "@/lib/approval-decision";

const baseProps = {
  command: "npm test",
  riskLine: "Medium risk. Build/dev command (safe list).",
  canAlwaysAllow: true,
  state: initialDecisionState,
};

describe("CommandApprovalCard", () => {
  it("renders the real command, risk line and all three choices", () => {
    render(<CommandApprovalCard {...baseProps} onDecide={() => {}} />);

    expect(screen.getByText(/wants to run npm test/)).toBeTruthy();
    expect(screen.getByText("Medium risk. Build/dev command (safe list).")).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
  });

  it("sends the command as text, never as markup", () => {
    const command = "<img src=x onerror=alert(1)> && echo done";
    render(<CommandApprovalCard {...baseProps} command={command} onDecide={() => {}} />);
    // Rendered as literal text: no element was created from it.
    expect(screen.getByLabelText(`Command: ${command}`).textContent).toContain(command);
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("maps clicks to decisions", () => {
    const onDecide = jest.fn();
    render(<CommandApprovalCard {...baseProps} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));

    expect(onDecide.mock.calls.map((c) => c[0])).toEqual(["allow", "deny", "always"]);
  });

  it("maps Enter to Allow and Escape to Deny", () => {
    const onDecide = jest.fn();
    render(<CommandApprovalCard {...baseProps} onDecide={onDecide} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onDecide.mock.calls.map((c) => c[0])).toEqual(["allow", "deny"]);
  });

  it("hides Always allow for dangerous commands and says why", () => {
    render(
      <CommandApprovalCard
        {...baseProps}
        command="rm -rf build"
        canAlwaysAllow={false}
        riskLine="High risk. Destructive or system-level command."
        onDecide={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(screen.getByText(/too risky to allow automatically/)).toBeTruthy();
  });

  it("disables the choices while a decision is in flight", () => {
    const onDecide = jest.fn();
    render(
      <CommandApprovalCard
        {...baseProps}
        state={{ phase: "submitting", choice: "allow", error: null }}
        onDecide={onDecide}
      />
    );
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    fireEvent.click(allow);
    expect(onDecide).not.toHaveBeenCalled();
    expect(allow.disabled).toBe(true);
  });

  it("shows an inline error and stays open", () => {
    render(
      <CommandApprovalCard
        {...baseProps}
        state={{ phase: "error", choice: null, error: "Could not save the allow rule." }}
        onDecide={() => {}}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("Could not save the allow rule.");
    const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
  });

  it("renders the result badge copy for allowed, always and denied", () => {
    const { rerender } = render(
      <CommandApprovalCard {...baseProps} state={{ phase: "result", choice: "allow", error: null }} onDecide={() => {}} />
    );
    expect(screen.getByRole("status").textContent).toBe("Allowed");

    rerender(
      <CommandApprovalCard {...baseProps} state={{ phase: "result", choice: "always", error: null }} onDecide={() => {}} />
    );
    expect(screen.getByRole("status").textContent).toBe("Always allowed");

    rerender(
      <CommandApprovalCard {...baseProps} state={{ phase: "result", choice: "deny", error: null }} onDecide={() => {}} />
    );
    expect(screen.getByRole("status").textContent).toBe("Denied");
  });
});
