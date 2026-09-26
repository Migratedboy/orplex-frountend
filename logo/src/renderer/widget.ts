import type { AppState } from '../shared/focuslock.ts';
import { crossedSecondBoundary, formatRemaining } from '../shared/focuslock.ts';
import { attachSpecularGlow } from './specular.ts';

// Boot marker: set before anything else in the module body. If this is
// missing in diagnostics, an IMPORT failed and the module never ran.
document.body.dataset.boot = 'imports-ok';

const circleEl = document.getElementById('circle') as HTMLDivElement;
const logoImg = document.getElementById('logo') as HTMLImageElement;
const segH = document.getElementById('seg-h') as HTMLDivElement;
const segM = document.getElementById('seg-m') as HTMLDivElement;
const segS = document.getElementById('seg-s') as HTMLDivElement;
const fillEl = document.getElementById('fill') as HTMLDivElement;

let lastState: AppState | null = null;
let prevNow = Date.now();

function setLocked(locked: boolean): void {
  document.body.classList.toggle('locked', locked);
}

async function loadLogo(): Promise<void> {
  try {
    const dataUrl = await window.focuslock.getLogoDataUrl();
    logoImg.src = dataUrl ?? inlineFallbackLogo();
    document.body.dataset.logo = dataUrl === null ? 'fallback' : 'png';
  } catch (err) {
    logoImg.src = inlineFallbackLogo();
    document.body.dataset.logo = `error:${String(err).slice(0, 60)}`;
  }
}

function inlineFallbackLogo(): string {
  // Same mark as assets/logo.svg so the widget is never blank.
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b6cff"/><stop offset="1" stop-color="#7a3cff"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#bg)"/><circle cx="32" cy="32" r="30" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"/><g fill="#fff"><path d="M22 18h20v4c0 4-3 6-5.5 8.5L32 35l-4.5-4.5C25 28 22 26 22 22z" opacity="0.95"/><path d="M22 46h20v-4c0-4-3-6-5.5-8.5L32 29l4.5 4.5C39 36 42 38 42 42z" opacity="0.8"/><circle cx="32" cy="44" r="3"/></g></svg>`
    )
  );
}

// Specular rim glow (ported shader effect). The canvas lives in a host that
// bleeds WIDGET_PAD px beyond the shape; the host is pointer-transparent.
// Wrapped so a shader/ctx failure can never take down the rest of the module.
const glowNoop = { dispose: () => undefined, setShape: () => undefined };
let glow: { dispose(): void; setShape(w: number, h: number): void } = glowNoop;
try {
  const glowHost = document.getElementById('glow-host') as HTMLDivElement;
  glow = attachSpecularGlow(glowHost, {
    radius: 32,
    lineColor: '#9fd0ff',
    baseColor: '#3a4258',
    intensity: 1,
    shineSize: 12,
    shineFade: 40,
    thickness: 1,
    speed: 0.35,
    followMouse: true,
  });
  glow.setShape(64, 64);
  document.body.dataset.glow = 'ok';
} catch (err) {
  document.body.dataset.glow = `error:${String(err).slice(0, 80)}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function render(state: AppState): void {
  const now = Date.now();
  const locked = state.phase === 'locked';
  setLocked(locked);
  glow.setShape(locked ? 172 : 64, 64);
  if (locked && state.endAt !== null) {
    const remaining = Math.max(0, state.endAt - now);
    const totalSeconds = Math.floor(remaining / 1000);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    segH.textContent = pad2(hh);
    segM.textContent = pad2(mm);
    segS.textContent = pad2(ss);
    if (lastState !== null && lastState.endAt !== null) {
      const dur = Math.max(1, lastState.endAt - (lastState.startedAt ?? 0));
      const done = 1 - remaining / dur;
      fillEl.style.width = `${Math.min(100, Math.max(0, done * 100))}%`;
    }
    circleEl.title = `FocusLock — ${formatRemaining(remaining)} left`;
  } else {
    segH.textContent = '00';
    segM.textContent = '00';
    segS.textContent = '00';
    fillEl.style.width = '0%';
    circleEl.title = 'FocusLock — click to set a timer';
  }
  prevNow = now;
  lastState = state;
}

window.focuslock.onStateChanged((state) => {
  // Leaving a session resets the confirm state.
  if (state.phase !== 'locked' && confirmTimeout !== null) {
    clearTimeout(confirmTimeout);
    confirmArmed = false;
  }
  render(state);
});

async function tick(): Promise<void> {
  const now = Date.now();
  if (
    lastState !== null &&
    lastState.phase === 'locked' &&
    lastState.endAt !== null &&
    crossedSecondBoundary(lastState.endAt, prevNow, now)
  ) {
    render(lastState);
  }
  prevNow = now;
}
setInterval(tick, 250);

// --- Pointer-drag: whole icon is draggable; a still press is a click. ---
// Uses SCREEN coordinates: client coords shift when the window itself moves,
// which creates a feedback loop (the "shaking" bug). Screen coords are
// window-independent, and we send the absolute target position so errors
// never accumulate.
const DRAG_THRESHOLD_PX = 4;
let dragging = false;
let dragMoved = false;
let activePointerId: number | null = null;
let startScreenX = 0;
let startScreenY = 0;
let grabOffsetX = 0;
let grabOffsetY = 0;

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  dragging = true;
  dragMoved = false;
  activePointerId = ev.pointerId;
  startScreenX = ev.screenX;
  startScreenY = ev.screenY;
  grabOffsetX = ev.screenX - window.screenX;
  grabOffsetY = ev.screenY - window.screenY;
  circleEl.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging || ev.pointerId !== activePointerId) return;
  if (
    !dragMoved &&
    Math.hypot(ev.screenX - startScreenX, ev.screenY - startScreenY) < DRAG_THRESHOLD_PX
  ) {
    return;
  }
  dragMoved = true;
  window.focuslock.moveWindowTo(
    Math.round(ev.screenX - grabOffsetX),
    Math.round(ev.screenY - grabOffsetY)
  );
}

function onPointerUp(ev: PointerEvent): void {
  if (ev.pointerId !== activePointerId) return;
  dragging = false;
  activePointerId = null;
  if (dragMoved) return;
  if (lastState !== null && lastState.phase === 'locked') {
    // During a class session: first click arms an "end early?" confirm;
    // clicking again within 4 s ends it. Lockdown has no escape.
    if (lastState.mode === 'lockdown') return;
    if (confirmArmed) {
      confirmArmed = false;
      if (confirmTimeout !== null) clearTimeout(confirmTimeout);
      window.focuslock.endClassSession();
    } else {
      confirmArmed = true;
      circleEl.title = 'Click again within 4 s to END this session';
      confirmTimeout = setTimeout(() => {
        confirmArmed = false;
        if (lastState !== null && lastState.phase === 'locked') {
          circleEl.title = `FocusLock — ${formatRemaining((lastState.endAt ?? 0) - Date.now())} left`;
        }
      }, 4000);
    }
    return;
  }
  window.focuslock.openPanel();
}

let confirmArmed = false;
let confirmTimeout: ReturnType<typeof setTimeout> | null = null;

circleEl.addEventListener('pointerdown', onPointerDown);
circleEl.addEventListener('pointermove', onPointerMove);
circleEl.addEventListener('pointerup', onPointerUp);
circleEl.addEventListener('pointercancel', () => {
  dragging = false;
  activePointerId = null;
});

void loadLogo();
