// SessionInsightsPopup.test.tsx — behaviour of the insights popup.
//
// Focus is on the parts that can lie to the user, not on pixels: lazy loading,
// the pin/dismiss interaction, and the honesty of what each section claims.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SessionInsightsPopup from "../SessionInsightsPopup";

const mockApiFetch = jest.fn();
jest.mock("@/lib/api-base", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));
// The popup now carries the fork action, which pulls in router/toast/transport.
// Fork is exercised elsewhere; these tests only care about the insights data.
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("../Toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));
jest.mock("@/lib/conversations-transport", () => ({
  forkConversation: jest.fn(),
  isLocalConversationMode: () => false,
}));
jest.mock("@/lib/navigation-events", () => ({ announceConversationOpen: jest.fn() }));

const SUMMARY = {
  tasks: { total: 3, completed: 2, failed: 1, running: 0 },
  toolCalls: 42,
  toolUsage: [
    { tool: "read_file", calls: 30 },
    { tool: "web_search", calls: 12 },
  ],
  outputs: [{ id: "a1", kind: "html", name: "Birthday site", createdAt: new Date().toISOString() }],
  trajectories: { total: 3, success: 2, partial: 0, failure: 1 },
  patterns: 1,
  semantic: { total: 5, vectorised: 4 },
};

const PATTERNS = [
  {
    name: "read_file → edit_file",
    description: "succeeded",
    steps: ["read_file", "edit_file"],
    successRate: 0.75,
    useCount: 4,
  },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path.includes("patterns=1")) return jsonResponse({ success: true, patterns: PATTERNS });
    return jsonResponse({ success: true, summary: SUMMARY });
  });
});

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /show session insights/i }));

describe("SessionInsightsPopup", () => {
  it("does not query until it is opened (landing on chat pays nothing)", async () => {
    render(<SessionInsightsPopup />);
    expect(mockApiFetch).not.toHaveBeenCalled();
    openPanel();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
  });

  it("renders Outputs and Used-in-this-session from the summary", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    expect(screen.getByText("Outputs")).toBeTruthy();
    // Tool ids are humanized for display, counts are shown.
    expect(screen.getByText("Read file")).toBeTruthy();
    expect(screen.getByText("×30")).toBeTruthy();
    expect(screen.getByText("Web search")).toBeTruthy();
  });

  it("shows real totals, not just the visible rows", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    expect(screen.getByText(/42 tool calls/)).toBeTruthy();
    expect(screen.getByText(/2\/3 tasks completed/)).toBeTruthy();
  });

  it("collapses a section on click and restores it", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    const outputsHead = screen.getByText("Outputs").closest("button")!;
    fireEvent.click(outputsHead);
    expect(screen.queryByText("Birthday site")).toBeNull();
    fireEvent.click(outputsHead);
    await screen.findByText("Birthday site");
  });

  it("renders learned patterns and shows the success rate honestly", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    // Patterns start collapsed; open them.
    fireEvent.click(screen.getByText("Learned patterns").closest("button")!);
    expect(screen.getByText(/read_file → edit_file/)).toBeTruthy();
    expect(screen.getByText(/75% · 4 runs/)).toBeTruthy();
  });

  it("says so plainly when there is nothing yet, instead of rendering empty", async () => {
    mockApiFetch.mockImplementation(async (path: string) =>
      path.includes("patterns=1")
        ? jsonResponse({ success: true, patterns: [] })
        : jsonResponse({
            success: true,
            summary: { ...SUMMARY, outputs: [], toolUsage: [], trajectories: { total: 0, success: 0, partial: 0, failure: 0 } },
          })
    );
    render(<SessionInsightsPopup />);
    openPanel();
    expect(await screen.findByText("Nothing produced yet.")).toBeTruthy();
    expect(screen.getByText("No tools used yet.")).toBeTruthy();
  });

  it("surfaces a load failure instead of an empty panel", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ success: false, error: "Not authorized" }, false, 401));
    render(<SessionInsightsPopup />);
    openPanel();
    expect(await screen.findByText(/Not authorized|HTTP 401/)).toBeTruthy();
  });

  it("closes on Escape", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Birthday site")).toBeNull());
  });

  it("does not fetch a second time on reopen", async () => {
    render(<SessionInsightsPopup />);
    openPanel();
    await screen.findByText("Birthday site");
    fireEvent.click(screen.getByRole("button", { name: /hide session insights/i }));
    openPanel();
    await screen.findByText("Birthday site");
    // One summary + one patterns fetch, not two rounds.
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });
});