/** @type {import('jest').Config} */
module.exports = {
  // Two projects, because the two kinds of suite need different environments
  // and mixing them causes real breakage:
  //   server — lib/route tests. They mock Prisma and must never touch a DOM.
  //   dom    — component tests. jsdom, or React cannot render at all.
  //
  // The .tsx pattern matters: component tests used to be written but NEVER RUN,
  // because testMatch only matched *.test.ts. TodoBar.test.tsx sat in the tree
  // looking like coverage while jest silently ignored it.
  projects: [
    {
      displayName: "server",
      preset: "ts-jest",
      testEnvironment: "node",
      roots: ["<rootDir>/src"],
      testMatch: ["**/__tests__/**/*.test.ts"],
      moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
      transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
      },
    },
    {
      displayName: "dom",
      preset: "ts-jest",
      testEnvironment: "jsdom",
      roots: ["<rootDir>/src"],
      testMatch: ["**/__tests__/**/*.test.tsx"],
      moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
      transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
      },
      setupFilesAfterEnv: ["<rootDir>/jest.setup.dom.ts"],
    },
  ],
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