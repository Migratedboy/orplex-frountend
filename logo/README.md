# FocusLock

A tiny Electron + TypeScript desktop widget. It sits on your screen as a **circle**
with a logo, wrapped in an animated **specular rim-glow** (a raw WebGL2 shader port,
no dependencies) that follows your mouse. The whole icon is **draggable**; click it,
set a duration, and it **morphs into a cylinder** that shows a live countdown while
your desktop is locked: fullscreen overlays on every monitor, a focus re-grab
watchdog, no close buttons, no menu. When the timer expires, everything lifts
automatically.

No frameworks. No runtime dependencies. Vanilla DOM + Electron + strict TypeScript.

## Run it

```bash
npm install
npm start        # build + run with the dev abort hotkey (Ctrl+Shift+Q)
```

Other scripts:

```bash
npm run typecheck   # strict tsc over main/preload and renderer configs
npm test            # node --test unit tests for the shared timer core
npm run prod        # build + run without the dev abort hotkey
npm run dist        # portable Windows build via electron-builder
```

## Use it

1. Click the circle widget (top-right by default, draggable).
2. Pick a **mode**:
   - **Class mode** (default) — pick your class window from the list; it is forced
     **borderless fullscreen** (chrome stripped, hidden from the Alt+Tab list) and
     kept topmost + focused by a PowerShell watchdog that re-asserts it every
     300 ms, so opening Instagram or Chrome bounces you straight back to the class.
     The glowing cylinder countdown floats above. The original window style and
     bounds are saved and restored when the session ends — even after a crash.
   - **Lockdown** — fullscreen overlays cover every display and the focus watchdog
     keeps you in. Strict mode (if built) additionally swallows Alt+Tab / Win key.
3. Set hours/minutes (or a preset) and press **Lock**.
4. Your widget position and any running session are persisted — if the app restarts
   mid-session, it resumes.

## Strict mode (optional, Windows)

Standard enforcement is Electron-only: always-on-top kiosk overlays on every monitor
plus a 400 ms focus watchdog. The Alt+Tab switcher may flash, but the switch does not
stick.

Strict mode adds a low-level keyboard hook (WH_KEYBOARD_LL) that truly swallows
Alt+Tab, both Win keys, Ctrl+Esc, Alt+Esc, Alt+F4, and the Task Manager hotkey
(Ctrl+Shift+Esc). It works in **both** Lockdown and Class mode. Two interchangeable
backends, picked automatically — strict is never faked and only honored when the
backend confirms the hook is actually installed:

1. **Native N-API addon** (preferred; needs Visual Studio Build Tools + Python):

   ```bash
   npm run build:native
   ```

2. **C# helper** — `native/KeyboardHook.cs`, compiled by the .NET Framework
   compiler that ships with every Windows install (no dependencies, no admin):

   ```bash
   npm run build:helper
   ```

Verify the hook truly blocks Alt+Tab with a synthetic-keypress test (launches the
helper, injects real Alt+Tab/Win presses via SendInput, reads the hook's blocked
counter over its named pipe):

```bash
npm run verify:strict
```

## Honest limitations

- `Ctrl+Alt+Del` (and launching Task Manager by hand) cannot be blocked by any
  userland program on Windows. Killing the app in Task Manager ends the lock.
- The lock is a commitment tool, not malware-proof security.
- During development a dev-only abort exists (`Ctrl+Shift+Q` or the flag
  `FOCUSLOCK_DEV_ABORT=1`). Packaged builds have **no in-app escape** by design.

## Logo

`assets/logo.svg` is the default mark. Drop your own `assets/logo.png` and rebuild to
override it — the widget and lock screen pick it up automatically.
