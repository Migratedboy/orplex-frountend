import { makeWidget } from "../src/widget.js";
it("makes a widget", () => {
  expect(makeWidget({ id: "a" }).id).toBe("a");
});
