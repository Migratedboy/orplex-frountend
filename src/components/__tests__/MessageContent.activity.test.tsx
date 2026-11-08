import { render, screen } from "@testing-library/react";
import MessageContent from "../MessageContent";

jest.mock("../MarkdownRenderer", () => ({
  __esModule: true,
  default: () => null,
}));

describe("MessageContent live activity", () => {
  it("shows a thinking pill for an empty live message outside the thinking phase", () => {
    render(<MessageContent content="" runLive />);

    expect(screen.getByRole("button", { name: /Working for 0 seconds/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking\.\.\./ })).toBeInTheDocument();
  });
});
