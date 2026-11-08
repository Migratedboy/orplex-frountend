import { render, screen } from "@testing-library/react";
import MessageContent from "../MessageContent";

jest.mock("../MarkdownRenderer", () => ({
  __esModule: true,
  default: () => null,
}));

describe("MessageContent live activity", () => {
  it("shows the unchanged working timer with a flat live thinking row", () => {
    render(<MessageContent content="" runLive />);

    expect(screen.getByRole("button", { name: /Working for 0 seconds/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking/ })).toBeInTheDocument();
    expect(document.querySelector(".otc-row.is-running")).toBeInTheDocument();
    expect(document.querySelector(".tp-pill")).not.toBeInTheDocument();
  });
});
