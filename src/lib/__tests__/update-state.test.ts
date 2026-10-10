// update-state.test.ts — updater card state machine (pure, no Electron).
import {
  applyUpdateEvent,
  initialUpdaterState,
  handleVersionedResponse,
  FORCE_UPDATE_EVENT,
} from "../update-state";

describe("applyUpdateEvent", () => {
  it("surfaces an available version", () => {
    const s = applyUpdateEvent(initialUpdaterState, {
      type: "bridge",
      status: { state: "available", version: "1.0.1" },
    });
    expect(s.phase).toBe("available");
    expect(s.version).toBe("1.0.1");
  });
  it("does not re-toast a dismissed version, but shows newer ones", () => {
    const dismissed = applyUpdateEvent(
      { ...initialUpdaterState, phase: "available", version: "1.0.1" },
      { type: "dismiss" }
    );
    expect(dismissed.phase).toBe("hidden");
    const same = applyUpdateEvent(dismissed, { type: "bridge", status: { state: "available", version: "1.0.1" } });
    expect(same.phase).toBe("hidden");
    const newer = applyUpdateEvent(dismissed, { type: "bridge", status: { state: "available", version: "1.0.2" } });
    expect(newer.phase).toBe("available");
  });
  it("dismissed downloads re-surface on the next check (install never strands)", () => {
    let s = applyUpdateEvent(initialUpdaterState, {
      type: "bridge",
      status: { state: "available", version: "1.0.1" },
    });
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "downloaded" } });
    s = applyUpdateEvent(s, { type: "dismiss" });
    expect(s.phase).toBe("hidden");
    // Same version check again (e.g. Settings → Check for updates) re-offers install.
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "available", version: "1.0.1" } });
    expect(s.phase).toBe("available");
  });
  it("late progress after cancel does not re-open the card", () => {
    let s = applyUpdateEvent(initialUpdaterState, {
      type: "bridge",
      status: { state: "available", version: "1.0.1" },
    });
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "downloading", percent: 40 } });
    s = applyUpdateEvent(s, { type: "dismiss" }); // optimistic cancel
    expect(s.phase).toBe("hidden");
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "downloading", percent: 41 } });
    expect(s.phase).toBe("hidden");
  });
  it("tracks download progress to 100 on downloaded", () => {
    let s = applyUpdateEvent(initialUpdaterState, {
      type: "bridge",
      status: { state: "available", version: "1.0.1" },
    });
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "downloading", percent: 6 } });
    expect(s.phase).toBe("downloading");
    expect(s.percent).toBe(6);
    s = applyUpdateEvent(s, { type: "bridge", status: { state: "downloaded" } });
    expect(s.phase).toBe("downloaded");
    expect(s.percent).toBe(100);
  });
  it("force beats cards but never interrupts a download", () => {
    const forced = applyUpdateEvent(initialUpdaterState, { type: "force", minVersion: "1.0.5" });
    expect(forced.phase).toBe("force");
    expect(forced.minVersion).toBe("1.0.5");
    const mid = applyUpdateEvent(
      { ...initialUpdaterState, phase: "downloading", percent: 50 },
      { type: "force", minVersion: "9.9.9" }
    );
    expect(mid.phase).toBe("downloading");
  });
  it("idle clears transient cards, never force", () => {
    const cleared = applyUpdateEvent(
      { ...initialUpdaterState, phase: "notice", error: "x" },
      { type: "bridge", status: { state: "idle" } }
    );
    expect(cleared.phase).toBe("hidden");
    const kept = applyUpdateEvent(
      { ...initialUpdaterState, phase: "force", minVersion: "1.0.5" },
      { type: "bridge", status: { state: "idle" } }
    );
    expect(kept.phase).toBe("force");
  });
});

describe("handleVersionedResponse", () => {
  it("dispatches force-update on 426 with a minVersion", () => {
    // Node env has no window — stub a minimal one over EventTarget.
    const target = new EventTarget();
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    g.window = {
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
      addEventListener: (t: string, l: EventListener) => target.addEventListener(t, l),
      removeEventListener: (t: string, l: EventListener) => target.removeEventListener(t, l),
      CustomEvent,
    };
    (g as { CustomEvent?: unknown }).CustomEvent = (g as { CustomEvent?: unknown }).CustomEvent ?? CustomEvent;
    const seen: string[] = [];
    const listener = (e: Event) =>
      seen.push((e as CustomEvent<{ minVersion?: string }>).detail?.minVersion || "");
    try {
      (g.window as { addEventListener: (t: string, l: EventListener) => void }).addEventListener(FORCE_UPDATE_EVENT, listener);
      handleVersionedResponse(426, { minVersion: "1.0.5", updateRequired: true });
      handleVersionedResponse(200, { minVersion: "9.9.9" });
      handleVersionedResponse(426, {});
    } finally {
      (g.window as { removeEventListener: (t: string, l: EventListener) => void }).removeEventListener(FORCE_UPDATE_EVENT, listener);
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    }
    expect(seen).toEqual(["1.0.5"]);
  });
});
