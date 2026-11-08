import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiFetch } from "@/lib/api-base";
import ChangesBar from "../ChangesBar";

jest.mock("@/lib/api-base", () => ({ apiFetch: jest.fn() }));

const pendingFiles = [
  {
    path: "src/one.ts",
    before: "const before = 1;",
    current: "const after = 1;",
    expected: "const after = 1;",
    encoding: "utf8",
    binary: false,
  },
  {
    path: "src/new.ts",
    before: null,
    current: "export const added = true;",
    expected: "export const added = true;",
    encoding: "utf8",
    binary: false,
  },
  {
    path: "src/removed.ts",
    before: "export const removed = true;",
    current: null,
    expected: null,
    encoding: "utf8",
    binary: false,
  },
];

describe("ChangesBar", () => {
  let visibleFiles: typeof pendingFiles;
  let apiFetchMock: jest.Mock;

  beforeEach(() => {
    visibleFiles = pendingFiles;
    apiFetchMock = apiFetch as jest.Mock;
    apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" || init?.method === "PUT") visibleFiles = [];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ files: visibleFiles }),
      } as Response;
    });
  });

  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it("opens all edits with the aggregate diff and closes on Escape", async () => {
    render(<ChangesBar isRunning={false} />);
    expect(await screen.findByText("3 files changed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View all edits" }));
    expect(await screen.findByRole("dialog", { name: "All edits" })).toBeInTheDocument();
    expect(screen.getByText("@@ new file @@")).toBeInTheDocument();
    expect(screen.getByText("@@ deleted file @@")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "All edits" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "View all edits" })).toHaveAttribute("aria-expanded", "false");
  });

  it("disables panel actions while the agent is running", async () => {
    render(<ChangesBar isRunning />);
    fireEvent.click(await screen.findByRole("button", { name: "View all edits" }));

    expect(screen.getByRole("button", { name: "Keep all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo all" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Keep src/one.ts" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true })])
    );
    expect(screen.getAllByRole("button", { name: "Undo src/one.ts" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true })])
    );
  });

  it("keeps all from the review panel and shows the resolved state", async () => {
    render(<ChangesBar isRunning={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "View all edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));

    expect(await screen.findByText("Changes kept")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/agent/history",
      expect.objectContaining({ method: "POST" })
    );
    expect(screen.queryByRole("dialog", { name: "All edits" })).not.toBeInTheDocument();
  });

  it("undoes all from the review panel and shows the resolved state", async () => {
    render(<ChangesBar isRunning={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "View all edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo all" }));

    expect(await screen.findByText("Changes undone")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/agent/history",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ action: "undo-pending", paths: pendingFiles.map((file) => file.path), confirmChanges: false }),
      })
    );
  });
});
