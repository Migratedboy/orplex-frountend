import { flakyAdd } from "../src/flaky.js";

it("adds", () => {
  expect(flakyAdd(2, 3)).toBe(5);
});
