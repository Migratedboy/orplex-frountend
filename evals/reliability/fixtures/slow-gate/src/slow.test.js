import { slowSquare } from "../src/slow.js";
jest.setTimeout(20000);
it("squares", () => {
  expect(slowSquare(4)).toBe(16);
});
