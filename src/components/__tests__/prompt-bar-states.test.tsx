import { act, fireEvent, render, screen } from "@testing-library/react";
import PromptBar, { type PromptBarModel, type PromptBarMode } from "../PromptBar";

const MODES: PromptBarMode[] = [
  { key: "ask", name: "Ask" },
  { key: "code", name: "Code" },
  { key: "plan", name: "Plan" },
];
const MODELS: PromptBarModel[] = [{ key: "orplex/test-model", name: "Test model" }];

describe("PromptBar conversation states", () => {
  it("uses the initial Ask prompt before the conversation starts", () => {
    render(<PromptBar conversationState="initial" modes={MODES} models={MODELS} defaultModel={MODELS[0].key} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "How can I help you today?");
    expect(screen.getByText("Orplex Agent can make mistakes. Verify important information.")).toBeVisible();
  });

  it("changes the prompt when the user chooses Code mode", () => {
    render(<PromptBar conversationState="initial" modes={MODES} models={MODELS} defaultModel={MODELS[0].key} />);

    fireEvent.click(screen.getByRole("button", { name: "Mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Code/ }));

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "What do you want to build?");
    expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Code");
  });

  it("sends the selected model, effort, mode, and draft through the existing callback", () => {
    const onSend = jest.fn();
    render(
      <PromptBar
        conversationState="initial"
        modes={MODES}
        models={MODELS}
        defaultModel={MODELS[0].key}
        defaultEffort="High"
        onSend={onSend}
      />
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Review this change" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false, isComposing: false });

    expect(onSend).toHaveBeenCalledWith(
      "Review this change",
      expect.objectContaining({ model: MODELS[0], effort: "High", mode: MODES[0], attachments: [] })
    );
  });

  it("shows elapsed thinking state and routes the stop action", () => {
    const onStop = jest.fn();
    render(<PromptBar conversationState="thinking" busy onStop={onStop} modes={MODES} models={MODELS} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Reply...");
    expect(screen.getByText("0s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows the live tool call, falls back to the real phase, and resets at completion", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-07T10:00:02.000Z"));
    const { rerender } = render(
      <PromptBar
        conversationState="thinking"
        busy
        requestStartedAt={Date.now() - 2000}
        statusPhase="writing"
        activeToolCall={{
          id: "tool-1",
          tool: "read_file",
          args: { path: "src/app/page.tsx" },
          startedAt: Date.now() - 1000,
        }}
        modes={MODES}
        models={MODELS}
      />
    );

    expect(screen.getByText("Reading")).toBeVisible();
    expect(screen.getByText("src/app/page.tsx")).toBeVisible();
    expect(screen.getByText("2s")).toBeVisible();

    act(() => {
      jest.advanceTimersByTime(4250);
    });
    expect(screen.queryByText("src/app/page.tsx")).not.toBeInTheDocument();
    expect(screen.getByText("Writing")).toBeVisible();

    rerender(<PromptBar conversationState="chat" modes={MODES} models={MODELS} />);
    expect(screen.queryByText("Writing")).not.toBeInTheDocument();
    jest.useRealTimers();
  });
});
