import {
  STRICT_ABORT_HOTKEY_LABEL,
  crossedSecondBoundary,
  formatRemaining,
  type AppState,
} from '../shared/focuslock.ts';
import type { FocuslockBridge } from './api';

declare global {
  interface Window {
    focuslock: FocuslockBridge;
  }
}

const countdownEl = document.getElementById('countdown') as HTMLDivElement;
const strictStatusEl = document.getElementById('strictstatus') as HTMLDivElement;
const abortEl = document.getElementById('abort') as HTMLDivElement;
const ringEl = document.querySelector('.ring') as HTMLDivElement;

// Full-bleed logo on the lock-screen ring, with a dark shading overlay.
void window.focuslock
  .getLogoDataUrl()
  .then((dataUrl) => {
    if (dataUrl !== null) {
      ringEl.style.backgroundImage =
        `linear-gradient(rgba(8,10,16,0.30), rgba(8,10,16,0.55)), url("${dataUrl}")`;
    }
  })
  .catch(() => undefined);

let lastState: AppState | null = null;
let prevNow = Date.now();
let lastShownSecond: string | null = null;

function isDevAbortEnabled(): boolean {
  return new URLSearchParams(location.search).get('devabort') === '1';
}

if (isDevAbortEnabled()) {
  abortEl.textContent = `Dev build: press ${STRICT_ABORT_HOTKEY_LABEL} to abort this lock.`;
}

function paint(state: AppState): void {
  if (state.endAt === null) return;
  const text = formatRemaining(state.endAt - Date.now());
  if (text !== lastShownSecond) {
    countdownEl.textContent = text;
    lastShownSecond = text;
  }
}

window.focuslock.onStateChanged((state) => {
  lastState = state;
  if (state.phase === 'locked') {
    paint(state);
  }
});

setInterval(() => {
  const now = Date.now();
  if (
    lastState !== null &&
    lastState.phase === 'locked' &&
    lastState.endAt !== null &&
    crossedSecondBoundary(lastState.endAt, prevNow, now)
  ) {
    paint(lastState);
  }
  prevNow = now;
}, 250);

void (async () => {
  try {
    const state = await window.focuslock.getState();
    if (state !== null && state.phase === 'locked') {
      lastState = state;
      paint(state);
      if (state.strictMode) {
        strictStatusEl.textContent =
          'Strict mode: system key combos are being swallowed by the keyboard hook.';
      }
    }
  } catch {
    // Non-fatal: state broadcasts will repaint the countdown.
  }
})();

export {};
