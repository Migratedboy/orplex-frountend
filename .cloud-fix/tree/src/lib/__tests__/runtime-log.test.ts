import { clearRuntimeLogs, getRuntimeLogs, recordRuntimeLog, runtimeLogCount } from "../runtime-log";

describe("runtime-log ring buffer", () => {
  beforeEach(() => clearRuntimeLogs());

  it("records newest-first with level and component", () => {
    recordRuntimeLog("executor", "info", "a");
    recordRuntimeLog("backup", "warn", "b");

    const logs = getRuntimeLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ component: "backup", level: "warn", message: "b" });
    expect(logs[1]).toMatchObject({ component: "executor", level: "info", message: "a" });
    expect(runtimeLogCount()).toBe(2);
  });

  it("trims to the cap, keeping the newest entries", () => {
    for (let i = 0; i < 250; i++) recordRuntimeLog("server", "info", `m${i}`);

    const logs = getRuntimeLogs(200);
    expect(logs).toHaveLength(200);
    expect(logs[0].message).toBe("m249"); // newest first
    expect(logs[199].message).toBe("m50"); // oldest kept
    expect(runtimeLogCount()).toBe(200);
  });

  it("clamps the requested limit and handles an empty buffer", () => {
    expect(getRuntimeLogs()).toEqual([]);
    recordRuntimeLog("cron", "error", "x");
    expect(getRuntimeLogs(1000)).toHaveLength(1);
    expect(getRuntimeLogs(0)).toHaveLength(1); // min 1
  });

  it("truncates oversized messages", () => {
    recordRuntimeLog("server", "info", "x".repeat(1000));
    expect(getRuntimeLogs()[0].message).toHaveLength(500);
  });
});
