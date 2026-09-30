/**
 * circuit-breaker.test.ts
 *
 * Tests the core logic of the circuit breaker. Since the DB-backed implementation
 * uses Prisma (which requires a running DB), we test the in-memory cache behavior
 * and the synchronous fallback path.
 */

import { isAvailableSync } from "../circuit-breaker";

describe("circuit-breaker", () => {
  describe("isAvailableSync", () => {
    it("returns true for unknown providers (fail-open)", () => {
      expect(isAvailableSync("nonexistent-provider")).toBe(true);
    });
  });

  // Note: Full integration tests for recordFailure, recordSuccess, isAvailable
  // require a running PostgreSQL database and Prisma client. These are best
  // tested in an integration test suite with a test database.
  //
  // Example integration test (not run in unit suite):
  //
  //   it("trips circuit after threshold failures", async () => {
  //     await recordFailure("test-provider");  // 1
  //     await recordFailure("test-provider");  // 2
  //     await recordFailure("test-provider");  // 3 — threshold
  //     expect(await isAvailable("test-provider")).toBe(false);
  //   });
  //
  //   it("resets on success", async () => {
  //     await recordFailure("test-provider");
  //     await recordSuccess("test-provider");
  //     expect(await isAvailable("test-provider")).toBe(true);
  //   });
  //
  //   it("half-opens after duration expires", async () => {
  //     await recordFailure("test-provider");
  //     await recordFailure("test-provider");
  //     await recordFailure("test-provider");
  //     // After 5+ minutes, isAvailable should return true (half-open)
  //     jest.useFakeTimers();
  //     jest.advanceTimersByTime(5 * 60 * 1000 + 1);
  //     expect(await isAvailable("test-provider")).toBe(true);
  //     jest.useRealTimers();
  //   });
});
