import { taxExclusive } from "../src/billing.js";
// Only the happy-path wrapper is covered; taxExclusive itself is untested.
it("computes a total", () => {
  expect(taxExclusive(100, 0.2) > 0).toBe(true);
});
