export function startDevSimulator(): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const sim = params.get("updateSim");
  if (!sim) return;
  void import("./updateStore").then((m) => {
    m.setCurrentVersion("1.2.6");
    if (sim === "available") {
      m.pushDevStatus({ state: "available", version: "1.2.7", notes: "- new: Faster agent runs with parallel tool calls\n- fix: Fixed provider key reset after restart" });
    } else if (sim === "downloading") {
      m.pushDevStatus({ state: "downloading", version: "1.2.7", percent: 62, bytesPerSecond: 7.4 * 1024 * 1024, transferred: 52 * 1024 * 1024, total: 84 * 1024 * 1024 });
    } else if (sim === "ready") {
      m.pushDevStatus({ state: "downloaded", version: "1.2.7" });
    } else if (sim === "installing") {
      m.pushDevStatus({ state: "downloaded", version: "1.2.7" });
      setTimeout(() => m.setPhase("installing"), 50);
    } else if (sim === "done") {
      try { localStorage.setItem("orplex.pendingUpdateTarget", "1.2.7"); } catch {}
      m.setCurrentVersion("1.2.7");
      m.markDoneIfNeeded("1.2.7");
    } else if (sim === "error") {
      m.pushDevStatus({ state: "error", error: "network timeout" });
    }
  });
}