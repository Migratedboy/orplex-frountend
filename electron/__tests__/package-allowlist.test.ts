// package-allowlist.test.ts — regression pins for the desktop installer
// allowlist.
//
// The bug these guard: Next's file tracing copies the whole project into
// .next/standalone, and the staging step shipped that tree verbatim — so the
// installer carried the repo's .env (database password + provider API keys),
// the previous 1 GB installer, a duplicate 556 MB Electron runtime and the
// coverage report. The 3.3 GB payload then broke the NSIS packer outright
// ("failed creating mmap" — makensis is 32-bit and cannot map >2 GB).
//
// The invariant: the packaged app contains the server it runs and the
// dependencies that server loads — and nothing else.

import {
  PRUNED_NODE_MODULES,
  SHIPPABLE_STANDALONE_ENTRIES,
  findLeakFiles,
  isLeakFileName,
  isPrismaEngineTempFile,
  partitionByDecision,
  planNodeModulesPrune,
  planPrismaClientPrune,
  planStandalonePrune,
} from "../package-allowlist";

describe("planStandalonePrune — only what the app runs survives", () => {
  it("keeps the server entry point, the compiled output, public and node_modules", () => {
    const { keep } = planStandalonePrune(["server.js", "package.json", ".next", "public", "node_modules", "prisma"]);
    expect(keep.sort()).toEqual([".next", "node_modules", "package.json", "prisma", "public", "server.js"].sort());
  });

  it("drops the repo's .env — it holds the database password", () => {
    const { drop } = planStandalonePrune([".env", "server.js"]);
    expect(drop).toContain(".env");
  });

  it("drops the previous release installer and its archive", () => {
    const { drop } = planStandalonePrune(["release", "server.js"]);
    expect(drop).toContain("release");
  });

  it("drops the source tree, the docs, the coverage report and the local logs", () => {
    const { drop } = planStandalonePrune([
      "src",
      "scripts",
      "docs",
      "docs-site",
      "coverage",
      "electron",
      "electron-dist",
      "dev-app.log",
      "server.js",
    ]);
    expect(drop).toEqual(
      expect.arrayContaining(["src", "scripts", "docs", "docs-site", "coverage", "electron", "electron-dist", "dev-app.log"])
    );
  });

  it("keeps nothing it does not know: an unknown entry is dropped, never kept", () => {
    const { keep, drop } = planStandalonePrune(["server.js", "something-new"]);
    expect(keep).toEqual(["server.js"]);
    expect(drop).toEqual(["something-new"]);
  });

  it("never keeps a file that only looks like the server entry", () => {
    const { drop } = planStandalonePrune(["server.js.bak", "server.jsx", "package.json.old"]);
    expect(drop).toEqual(expect.arrayContaining(["server.js.bak", "server.jsx", "package.json.old"]));
  });

  it("has an explicit allowlist (not an accidental set)", () => {
    expect(SHIPPABLE_STANDALONE_ENTRIES).toContain("server.js");
    expect(SHIPPABLE_STANDALONE_ENTRIES).not.toContain("release");
    expect(SHIPPABLE_STANDALONE_ENTRIES).not.toContain(".env");
  });
});

describe("planNodeModulesPrune", () => {
  it("drops the duplicate Electron runtime (556 MB, including the stock electron.exe)", () => {
    const { drop } = planNodeModulesPrune(["electron", "next", "react-dom", ".prisma"]);
    expect(drop).toEqual(["electron"]);
    expect(PRUNED_NODE_MODULES).toContain("electron");
  });

  it("keeps the Prisma client and the server dependencies", () => {
    const { keep } = planNodeModulesPrune([".prisma", "@prisma", "next", "sharp"]);
    expect(keep).toEqual([".prisma", "@prisma", "next", "sharp"]);
  });
});

describe("planPrismaClientPrune — orphaned `prisma generate` temp files", () => {
  it("drops the *.tmp<pid> leftovers (14 of them cost 257 MB)", () => {
    const { drop } = planPrismaClientPrune([
      "query_engine-windows.dll.node",
      "query_engine-windows.dll.node.tmp17988",
      "query_engine-windows.dll.node.tmp18608",
      "schema.prisma",
    ]);
    expect(drop).toEqual([
      "query_engine-windows.dll.node.tmp17988",
      "query_engine-windows.dll.node.tmp18608",
    ]);
  });

  it("keeps the real engine and the schema", () => {
    const { keep } = planPrismaClientPrune(["query_engine-windows.dll.node", "schema.prisma"]);
    expect(keep).toEqual(["query_engine-windows.dll.node", "schema.prisma"]);
  });

  it("recognises the temp-file shape and nothing else", () => {
    expect(isPrismaEngineTempFile("query_engine-windows.dll.node.tmp17988")).toBe(true);
    expect(isPrismaEngineTempFile("query_engine-windows.dll.node")).toBe(false);
    expect(isPrismaEngineTempFile("something.tmp")).toBe(false);
    expect(isPrismaEngineTempFile("a.tmp123")).toBe(true);
  });
});

describe("isLeakFileName — what must never ship", () => {
  it("flags every .env variant", () => {
    expect(isLeakFileName(".env")).toBe(true);
    expect(isLeakFileName(".env.local")).toBe(true);
    expect(isLeakFileName(".env.production.local")).toBe(true);
  });

  it("flags the repo's secret-marker file", () => {
    expect(isLeakFileName("nexus_core_super_secret_change_in_production_k8x2m9p4q7w1")).toBe(true);
  });

  it("flags private keys and certificates", () => {
    expect(isLeakFileName("server.pem")).toBe(true);
    expect(isLeakFileName("client.p12")).toBe(true);
    expect(isLeakFileName("id_rsa")).toBe(true);
  });

  it("does NOT flag the compiled secret-scanner chunk (it is a legitimate part of the app)", () => {
    expect(isLeakFileName("src_lib_plugins_builtin_secret-scanner-plugin_ts_14z.js")).toBe(false);
  });

  it("does NOT flag ordinary app files", () => {
    expect(isLeakFileName("server.js")).toBe(false);
    expect(isLeakFileName("app-config.json")).toBe(false);
    expect(isLeakFileName("latest.yml")).toBe(false);
    expect(isLeakFileName("icon.ico")).toBe(false);
  });

  it("still flags a .env inside node_modules (third-party fixtures are not our leak)", () => {
    expect(isLeakFileName(".env", true)).toBe(true);
    // ...but a third-party .pem fixture must not be able to fail our build.
    expect(isLeakFileName("fixtures/key.pem", true)).toBe(false);
  });
});

describe("findLeakFiles — the guard that fails the release build", () => {
  it("finds a .env at any depth", () => {
    const leaks = findLeakFiles([
      ".next/standalone/.env",
      ".next/standalone/node_modules/pkg/.env",
      ".next/standalone/server.js",
    ]);
    expect(leaks).toEqual([
      ".next/standalone/.env",
      ".next/standalone/node_modules/pkg/.env",
    ]);
  });

  it("normalizes Windows separators", () => {
    const leaks = findLeakFiles([".next\\standalone\\.env"]);
    expect(leaks).toEqual([".next/standalone/.env"]);
  });

  it("finds nothing in a clean tree", () => {
    const leaks = findLeakFiles([
      ".next/standalone/server.js",
      ".next/standalone/.next/server/chunks/secret-scanner-plugin.js",
      ".next/standalone/public/favicon.ico",
      "electron/assets/icon.ico",
    ]);
    expect(leaks).toEqual([]);
  });
});

describe("partitionByDecision", () => {
  it("splits entries without losing or duplicating any", () => {
    const entries = ["a", "b", "c", "d"];
    const { keep, drop } = partitionByDecision(entries, (n) => n === "a" || n === "c");
    expect(keep).toEqual(["a", "c"]);
    expect(drop).toEqual(["b", "d"]);
    expect(keep.length + drop.length).toBe(entries.length);
  });
});
