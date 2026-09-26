import {
  STRICT_ABORT_HOTKEY_LABEL,
  formatRemaining,
  isSessionMode,
  type StartTimerResult,
} from '../shared/focuslock.ts';
import type { FocuslockBridge } from './api';

const hoursEl = document.getElementById('hours') as HTMLInputElement;
const minutesEl = document.getElementById('minutes') as HTMLInputElement;
const strictEl = document.getElementById('strict') as HTMLInputElement;
const lockBtn = document.getElementById('lock') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const strictNoteEl = document.getElementById('strict-note') as HTMLDivElement;
const classSection = document.getElementById('class-section') as HTMLDivElement;
const windowSelect = document.getElementById('window-select') as HTMLSelectElement;
const refreshBtn = document.getElementById('refresh-windows') as HTMLButtonElement;

declare global {
  interface Window {
    focuslock: FocuslockBridge;
  }
}

function readPositiveInt(el: HTMLInputElement, fallback: number): number {
  const parsed = Number.parseInt(el.value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function selectedMode(): 'lockdown' | 'class' {
  const checked = document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null;
  const value = checked?.value;
  return isSessionMode(value) ? value : 'class';
}

function updateClassSectionVisibility(): void {
  classSection.classList.toggle('hidden', selectedMode() !== 'class');
}

async function refreshWindows(): Promise<void> {
  const previous = windowSelect.value;
  windowSelect.replaceChildren();
  try {
    const windows = await window.focuslock.getWindows();
    if (windows.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No windows found';
      windowSelect.append(opt);
      return;
    }
    for (const win of windows) {
      const opt = document.createElement('option');
      opt.value = win.hwnd;
      opt.textContent = win.name.slice(0, 60);
      windowSelect.append(opt);
    }
    if (previous !== '') {
      windowSelect.value = previous;
    }
  } catch {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Could not list windows';
    windowSelect.append(opt);
  }
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', updateClassSectionVisibility);
}
refreshBtn.addEventListener('click', () => {
  void refreshWindows();
});

function isDevAbortEnabled(): boolean {
  return new URLSearchParams(location.search).get('devabort') === '1';
}

let abortWired = false;

function wireAbortHotkey(): void {
  if (abortWired || !isDevAbortEnabled()) return;
  abortWired = true;
  // Informational only: the real handler lives in the main process.
  errorEl.textContent = `Dev abort available: ${STRICT_ABORT_HOTKEY_LABEL}`;
}

async function refreshStrictNote(): Promise<void> {
  try {
    const state = await window.focuslock.getState();
    strictNoteEl.textContent =
      state && state.strictMode
        ? 'Strict mode active: Alt+Tab and the Win key are being swallowed.'
        : 'Blocks Alt+Tab and the Win key for the whole session (all modes).';
  } catch {
    strictNoteEl.textContent = 'Blocks Alt+Tab and the Win key for the whole session (all modes).';
  }
}

function showStartResult(result: StartTimerResult): void {
  if (result.ok) {
    window.focuslock.closePanel();
    return;
  }
  errorEl.textContent = result.error;
}

async function onStart(): Promise<void> {
  lockBtn.disabled = true;
  try {
    const h = readPositiveInt(hoursEl, 0);
    const m = readPositiveInt(minutesEl, 0);
    if (h === 0 && m === 0) {
      errorEl.textContent = 'Set a duration greater than zero.';
      return;
    }
    if (selectedMode() === 'class' && windowSelect.value === '') {
      errorEl.textContent = 'Pick your class window first (or switch to Lockdown).';
      return;
    }
    const durationMs = (h * 3600 + m * 60) * 1000;
    const result = await window.focuslock.startTimer({
      durationMs,
      strictMode: strictEl.checked,
      mode: selectedMode(),
      pinHwnd: selectedMode() === 'class' ? windowSelect.value : null,
    });
    showStartResult(result);
  } finally {
    lockBtn.disabled = false;
  }
}

lockBtn.addEventListener('click', () => {
  void onStart();
});

cancelBtn.addEventListener('click', () => {
  window.focuslock.closePanel();
});

hoursEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') void onStart();
});
minutesEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') void onStart();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') window.focuslock.closePanel();
});

void (async () => {
  try {
    const state = await window.focuslock.getState();
    if (state !== null && state.phase === 'locked' && state.endAt !== null) {
      errorEl.textContent = `Session running — ${formatRemaining(state.endAt - Date.now())} left.`;
      lockBtn.disabled = true;
    }
  } catch {
    // Panel still usable; main will reject duplicate starts anyway.
  }
  refreshStrictNote();
  wireAbortHotkey();
  updateClassSectionVisibility();
  await refreshWindows();
})();

export {};
