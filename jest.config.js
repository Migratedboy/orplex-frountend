/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
  },
  // OOM fix: each ts-jest worker compiles the whole dep graph into its own
  // heap; with the default (cores/2) workers V8 exceeded its default heap.
  // Cap workers and recycle workers once idle memory climbs — the standard
  // Jest remedy for ts-jest OOM ("JavaScript heap out of memory" in V8 zone).
  maxWorkers: 2,
  workerIdleMemoryLimit: "512MB",
  // Background timers (rate-limiter sweep, TPM pacer) previously kept workers
  // alive after suites finished, producing "failed to exit gracefully" and
  // 5+ minute hangs. Timers are now unref'd at the source; forceExit is the
  // belt-and-suspenders fallback for anything that slips through.
  forceExit: true,
  // Slow suites (live-validate, browser-verify-lane) wait on real timers.
  testTimeout: 20000,
};
