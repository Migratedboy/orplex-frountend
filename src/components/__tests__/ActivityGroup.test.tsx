import { fireEvent, render, screen } from "@testing-library/react";
import ActivityGroup from "../activity/ActivityGroup";
import type { ActivityGroup as ActivityGroupData } from "@/lib/activity";

jest.mock("motion/react", () => ({ useReducedMotion: () => false }));

describe("ActivityGroup", () => {
  it("shows elapsed working status and the live thinking indicator before tool activity starts", () => {
    render(
      <ActivityGroup
        live
        activity={{ id: "activity-live", startedAt: Date.now(), steps: [] }}
      />
    );

    expect(screen.getByText("Working for 0 seconds")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking\.\.\./ })).toBeInTheDocument();
    expect(document.querySelector(".tp-activity-summary-indicator.is-live")).toBeInTheDocument();
  });

  it("collapses completed activity and reveals a Read row's output on demand", () => {
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
    const pill = screen.getByRole("button", { name: /Worked for 1 second/ });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("less than 1 second")).not.toBeInTheDocument();
    expect(document.querySelector(".tp-activity-card")).toHaveAttribute("hidden");

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    const summary = screen.getByRole("button", { name: /Read 1 file\. Expand details/ });
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(document.querySelector(".tp-activity-card")).not.toHaveAttribute("hidden");
    expect(document.querySelector(".tp-activity-body")).toHaveAttribute("hidden");

    fireEvent.click(summary);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".tp-activity-body")).not.toHaveAttribute("hidden");
    expect(document.querySelector(".tp-activity-step-done")).toBeInTheDocument();

    fireEvent.click(summary);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".tp-activity-card")).not.toHaveAttribute("hidden");
    expect(document.querySelector(".tp-activity-body")).toHaveAttribute("hidden");

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".tp-activity-card")).toHaveAttribute("hidden");
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: /Read 1 file\. Expand details/ }));
    fireEvent.click(screen.getByRole("button", { name: /Read src\/app\/page\.tsx/ }));
    expect(screen.getByText("export default function Page() {}")).toBeVisible();
  });
});
