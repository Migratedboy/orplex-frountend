// icon-poison.ts — Windows taskbar ICON-POISON detection (pure, no electron).
//
// The bug this exists for: Electron's Windows toast-notification path
// self-installs a Start Menu shortcut named "Electron.lnk" that carries the
// CURRENT app's AppUserModelID. In a dev run that AUMID is
// "tech.orplex.app.dev" — the SAME id our window declares — and the shortcut
// points at the STOCK electron.exe. Windows then resolves the taskbar button
// through that shortcut, so the generic Electron logo and the label "Electron"
// win over the branded dev binary (orplex-dev.exe) and over
// BrowserWindow.setIcon / setAppDetails. The user sees an Electron icon in
// the taskbar and calls it "the modularization poisoning the icon".
//
// The sweep that removes the shortcut used to run in the PACKAGED app only,
// so the dev taskbar stayed poisoned forever. The detection logic lives here
// so both lanes share it and so it can be unit-tested without a Windows
// shell (no electron import on purpose — jest runs this as a plain module).

/** The shortcut name Electron installs on Windows. */
export const POISON_SHORTCUT_NAME = "Electron.lnk";

/**
 * True when a shortcut target is an UNBRANDED electron.exe — i.e. the poison.
 *
 * Deliberately narrow, because this decides whether a user-visible shortcut
 * gets deleted:
 *  - "electron.exe" under an electron/dist folder or a node_modules/electron
 *    tree is the stock Electron binary → poison.
 *  - The branded dev binary ("orplex-dev.exe") is NOT poison.
 *  - An installed "Orplex Code.exe" is NOT poison.
 *  - Anything else (a browser, a game, an unrelated app) is NOT poison.
 */
export function isIconPoisonTarget(target: string | undefined | null): boolean {
  if (!target) return false;
  const t = String(target).replace(/\\/g, "/");
  // Basename must be exactly electron.exe (not electron, not electron-x.exe).
  if (!/\/electron\.exe$/i.test(t)) return false;
  return (
    /\/electron\/dist\/electron\.exe$/i.test(t) ||
    /\/node_modules\/electron\//i.test(t) ||
    /\/electron\/dist\//i.test(t)
  );
}

/**
 * The full Start Menu path of the poison shortcut, given the user profile's
 * appData folder (Windows: %APPDATA%).
 */
export function poisonShortcutPath(appDataDir: string, sep = "\\"): string {
  const parts = ["Microsoft", "Windows", "Start Menu", "Programs", POISON_SHORTCUT_NAME];
  return [appDataDir, ...parts].join(sep);
}

export interface PoisonSweepResult {
  /** Paths of the poison shortcuts that were deleted. */
  removed: string[];
  /** Candidates that were inspected but legitimately kept. */
  kept: number;
  /** Error messages from candidates that could not be inspected. */
  errors: string[];
}

/**
 * Remove poison shortcuts from the Start Menu.
 *
 * The filesystem and shortcut-reading are INJECTED so this is unit-testable
 * without a Windows shell (no electron import on purpose). The caller must
 * invoke this in BOTH dev and packaged lanes: the poison is created by
 * Electron's toast path in dev too, and it carries the dev AUMID, so a
 * packaged-only sweep leaves the dev taskbar broken.
 *
 * Every candidate is judged by its TARGET, not by its file name: Electron may
 * name the shortcut "Electron.lnk" or after the app name, so a name-based
 * sweep would miss the renamed variant.
 */
export function sweepIconPoison(deps: {
  /** Shortcut paths to inspect. */
  candidates: string[];
  exists: (p: string) => boolean;
  readTarget: (p: string) => string | undefined;
  remove: (p: string) => void;
}): PoisonSweepResult {
  const removed: string[] = [];
  const errors: string[] = [];
  let kept = 0;
  for (const candidate of deps.candidates) {
    try {
      if (!deps.exists(candidate)) continue;
      const target = deps.readTarget(candidate);
      if (!isIconPoisonTarget(target)) {
        kept++;
        continue;
      }
      deps.remove(candidate);
      removed.push(candidate);
    } catch (err) {
      errors.push(String((err as Error)?.message ?? err));
    }
  }
  return { removed, kept, errors };
}
