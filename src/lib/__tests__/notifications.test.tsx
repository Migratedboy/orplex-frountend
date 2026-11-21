// The notification chime is driven by a setting, so it must be silent when the
// setting is off and when the user is already looking at the window.

import { notifyRunFinished, playFinishedChime, resetAudioContextForTests } from "@/lib/notifications";
import { APP_SETTINGS_KEY } from "@/lib/app-settings";

class FakeParam {
  calls: string[] = [];
  setValueAtTime() { this.calls.push("set"); return this; }
  exponentialRampToValueAtTime() { this.calls.push("ramp"); return this; }
}
class FakeOsc {
  type = "sine";
  frequency = { value: 0 };
  started = false;
  connect() { return { connect: () => undefined }; }
  start() { this.started = true; }
  stop() {}
}
class FakeGain {
  gain = new FakeParam();
  connect() { return { connect: () => undefined }; }
}

describe("notification chime", () => {
  let oscillators: FakeOsc[];
  let resumeCalls: number;

  beforeEach(() => {
    oscillators = [];
    resumeCalls = 0;
    resetAudioContextForTests();
    window.localStorage.clear();
    (window as unknown as { AudioContext: unknown }).AudioContext = function AudioContextStub(this: unknown) {
      return {
        state: "running",
        currentTime: 0,
        destination: {},
        resume: () => { resumeCalls++; return Promise.resolve(); },
        createOscillator: () => { const o = new FakeOsc(); oscillators.push(o); return o; },
        createGain: () => new FakeGain(),
      };
    } as unknown as typeof AudioContext;
  });

  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    resetAudioContextForTests();
  });

  it("stays silent when the setting is off", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ sounds: false }));
    playFinishedChime();
    expect(oscillators).toHaveLength(0);
  });

  it("plays two tones when the setting is on", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ sounds: true }));
    playFinishedChime();
    expect(oscillators).toHaveLength(2);
    expect(oscillators.every((o) => o.started)).toBe(true);
  });

  it("does not chime for a run that finishes in the focused window", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ sounds: true }));
    const focus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
    notifyRunFinished();
    expect(oscillators).toHaveLength(0);
    focus.mockRestore();
  });

  it("chimes when the window is in the background", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ sounds: true }));
    const focus = jest.spyOn(document, "hasFocus").mockReturnValue(false);
    notifyRunFinished();
    expect(oscillators).toHaveLength(2);
    focus.mockRestore();
  });

  it("survives a browser with no Web Audio at all", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    resetAudioContextForTests();
    expect(() => playFinishedChime()).not.toThrow();
  });
});
