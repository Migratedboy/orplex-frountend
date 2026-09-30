/**
 * CI-condition simulation: hide rg from PATH so the node fallback engine
 * runs (as on ubuntu runners), then assert the truncation contract.
 */
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFile: (cmd: string, ...rest: unknown[]) => {
      if (/^(rg|ripgrep)$/i.test(require("path").basename(cmd))) {
        const cb = rest[rest.length - 1] as (e: Error | null) => void;
        const err = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
        setImmediate(() => cb(err));
        return { on() {}, kill() {} } as never;
      }
      return (actual as typeof import("child_process")).execFile(cmd, ...(rest as []));
    },
  };
}, { virtual: true });

import { grepSearch, MAX_SEARCH_MATCHES } from "../grep-search";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "grep-nodetest-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("grepSearch node-engine truncation (CI condition: no rg)", () => {
  it("marks truncated when matches exceed the cap", async () => {
    for (let f = 0; f < 50; f++) {
      await writeFile(path.join(dir, `hot${f}.txt`), Array.from({ length: 5 }, (_, i) => `file${f} line${i} needle`).join("\n"));
    }
    const result = await grepSearch(dir, "needle");
    expect(result).not.toBeNull();
    expect(result!.engine).toBe("node");
    expect(result!.truncated).toBe(true);
  });
});
