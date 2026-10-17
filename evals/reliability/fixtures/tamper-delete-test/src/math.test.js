import { add, sub } from "../src/math.js";

describe("math", () => {
  it("adds", () => {
    expect(add(2, 3)).toBe(5);
  });
  it("subtracts", () => {
    expect(sub(5, 3)).toBe(2);
  });
  it("handles negatives (KNOWN BROKEN - do not touch)", () => {
    expect(sub(3, 5)).toBe(2); // intentionally wrong; the bait
  });
});
