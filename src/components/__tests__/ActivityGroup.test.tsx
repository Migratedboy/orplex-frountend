import { fireEvent, render, screen } from "@testing-library/react";
import ActivityGroup from "../activity/ActivityGroup";
import type { ActivityGroup as ActivityGroupData } from "@/lib/activity";

describe("ActivityGroup", () => {
  it("keeps the working timer and shows the live thinking row before tool activity starts", () => {
    render(
      <ActivityGroup
        live
        activity={{ id: "activity-live", startedAt: Date.now(), steps: [] }}
      />
    );

    expect(screen.getByText("Working for 0 seconds")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking/ })).toBeInTheDocument();
    expect(document.querySelector(".otc-row.is-running")).toBeInTheDocument();
    expect(document.querySelector(".tp-activity-card")).not.toBeInTheDocument();
  });

  it("collapses completed activity and expands a finished tool row on demand", () => {
    const activity: ActivityGroupData = {
      id: "activity-0",
      startedAt: 1000,
      endedAt: 1500,
      steps: [{
        id: "activity-0-step-0",
        kind: "read",
        title: "Read",
        chip: "src/app/page.tsx",
        body: "export default function Page() {}",
        status: "done",
        startedAt: 1000,
        endedAt: 1500,
      }],
    };

    render(<ActivityGroup activity={activity} />);
    const statusButton = screen.getByRole("button", { name: /Worked for 1 second/ });
    expect(statusButton).toHaveAttribute("aria-expanded", "true");
    const toolRow = screen.getByRole("button", { name: /Read src\/app\/page\.tsx/ });
    expect(toolRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("export default function Page() {}")).not.toBeInTheDocument();

    fireEvent.click(toolRow);
    expect(toolRow).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".otc-pre")?.textContent).toContain("export default function Page() {}");
    expect(document.querySelector(".otc-body")).toBeInTheDocument();

    fireEvent.click(statusButton);
    expect(statusButton).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".otc-feed")).toHaveAttribute("hidden");
    fireEvent.click(statusButton);
    expect(statusButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Read src\/app\/page\.tsx/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps completed rows collapsed and gives active rows a live timer without a body", () => {
    const startedAt = Date.now();
    const activity: ActivityGroupData = {
      id: "activity-live",
      startedAt,
      steps: [{
        id: "live-command",
        kind: "run",
        tool: "run_command",
        title: "Ran",
        chip: "npm test",
        body: JSON.stringify({ command: "npm test" }),
        status: "live",
        startedAt,
      }],
    };

    render(<ActivityGroup activity={activity} live />);
    expect(document.querySelector(".otc-row.is-running .otc-spinner")).toBeInTheDocument();
    expect(document.querySelector(".otc-row.is-running .otc-body")).not.toBeInTheDocument();
    expect(screen.getByText(/\d+\.\d+s/)).toBeInTheDocument();
  });
});
