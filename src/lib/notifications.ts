// notifications.ts — the only place the app makes a noise.
//
// The "Notification sounds" setting used to be a switch that wrote a
// localStorage key nobody read. This module is the reader: one short chime,
// synthesised with the Web Audio API so there is no audio asset to ship, played
// only when the run actually finished and the user is not looking at the window.
//
// Everything is best-effort: browsers block audio before a user gesture, a
// closed AudioContext throws, and none of that may break a finished run.

import { readAppSettings } from "@/lib/app-settings";

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Two short notes (~180ms total). Silent no-op when sounds are off. */
export function playFinishedChime(): void {
  if (typeof window === "undefined") return;
  if (!readAppSettings().sounds) return;
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  try {
    const start = ac.currentTime;
    [880, 1174.7].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = start + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    });
  } catch {
    /* audio is a nicety, never a failure path */
  }
}

/**
 * Chimed when a run reaches a terminal state. Skipped when the window is
 * focused — the user is already watching the result appear.
 */
export function notifyRunFinished(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  playFinishedChime();
}

/** Test seam: drop the cached context so a fresh one is built next time. */
export function resetAudioContextForTests(): void {
  ctx = null;
}
