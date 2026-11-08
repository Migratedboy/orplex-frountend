import { fireEvent, render } from "@testing-library/react";
import ToolCallDisplay from "../ToolCallDisplay";

describe("ToolCallDisplay", () => {
  it("uses the registered icon, verb, category color and extension badge", () => {
    const { container } = render(
      <ToolCallDisplay
        tool="write_file"
        args={{ path: "src/app.tsx" }}
        success
        status="success"
      />
    );

    expect(container.querySelector(".otc-cat-edit")).toBeInTheDocument();
    expect(container.querySelector(".otc-icon-svg path")).toHaveAttribute("d", expect.stringContaining("M4 1.5h5"));
    expect(container.querySelector(".otc-verb")).toHaveTextContent("Wrote");
    expect(container.querySelector(".otc-ext")).toHaveTextContent("TSX");
  });

  it("keeps running rows flat and without an expandable body", () => {
    const { container } = render(
      <ToolCallDisplay tool="run_command" args={{ command: "npm test" }} status="running" />
    );

    expect(container.querySelector(".otc-row")).toHaveClass("is-running");
    expect(container.querySelector(".otc-spinner")).toBeInTheDocument();
    expect(container.querySelector(".otc-row .otc-body")).not.toBeInTheDocument();
    expect(container.querySelector(".otc-h")).toHaveAttribute("disabled");
  });

  it("uses a neutral generic renderer for unregistered tools", () => {
    const { container } = render(
      <ToolCallDisplay
        tool="custom_metric_probe"
        args={{ metric: "cpu", threshold: 80 }}
        success
      />
    );

    expect(container.querySelector(".otc-cat-generic")).toBeInTheDocument();
    fireEvent.click(container.querySelector(".otc-h")!);
    expect(container.querySelector(".otc-kv")).toHaveTextContent("metric");
    expect(container.querySelector(".otc-kv")).toHaveTextContent("cpu");
  });

  it("renders every reference body type inside the expandable panel", () => {
    const bodies: Array<[string, Record<string, unknown>, string]> = [
      ["code", { k: "code", lines: [[1, "const count = 2;"]] }, "const count = 2;"],
      ["diff", { k: "diff", lines: [["p", 1, "added"]] }, "added"],
      ["term", { k: "term", cmd: "npm test", out: "PASS suite" }, "PASS suite"],
      ["tree", { k: "tree", items: [["f", "file.ts", "1 KB"]] }, "file.ts"],
      ["hits", { k: "hits", q: "needle", items: [["file.ts", 2, "found needle"]] }, "found needle"],
      ["web", { k: "web", items: [["Result", "example.test", "Summary"]] }, "Summary"],
      ["check", { k: "check", items: [["ok", "Typecheck", "0 errors"]] }, "Typecheck"],
      ["kv", { k: "kv", rows: [["key", "value"]] }, "value"],
      ["json", { k: "json", args: { key: "value" }, res: { count: 1 } }, "result"],
      ["logs", { k: "logs", rows: [["error", "failed request", "api"]] }, "failed request"],
      ["card", { k: "card", name: "artifact.txt", size: "1 KB", ttl: "4h" }, "artifact.txt"],
      ["prog", { k: "prog", pct: 60, label: "60% complete" }, "60% complete"],
      ["shot", { k: "shot", url: "localhost", vp: "mobile", size: "390 × 844" }, "localhost"],
      ["note", { k: "note", secs: [["plan", "next step"]], kept: "1 of 2" }, "next step"],
      ["ask", { k: "ask", q: "Choose", opts: [["Option", "Description"]], free: true }, "Description"],
      ["els", { k: "els", els: [["e1", "button", "Save", "#save"]] }, "#save"],
      ["tabs", { k: "tabs", tabs: [[1, "Active", "localhost"]] }, "Active"],
      ["eval", { k: "eval", expr: "1 + 1", res: "2" }, "2"],
      ["think", { k: "think", text: "First paragraph\nSecond paragraph" }, "Second paragraph"],
      ["sub", { k: "sub", answer: "Subagent answer", items: [] }, "Subagent answer"],
    ];

    for (const [, body, expected] of bodies) {
      const { container, unmount } = render(<ToolCallDisplay tool="mcp_call" args={{ body }} success />);
      fireEvent.click(container.querySelector(".otc-h")!);
      expect(container.querySelector(".otc-body")?.textContent).toContain(expected);
      unmount();
    }
  });
});
