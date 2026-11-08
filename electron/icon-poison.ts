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
 * Our branded copy of the Electron binary (scripts/dev-branded-electron.mjs).
 * It is still a BARE Electron runtime: launched without an app path it shows
 * Electron's default_app welcome window, not Orplex Code.
 */
export const DEV_BINARY_NAME = "orplex-dev.exe";

/** Windows path → file name, independent of the host platform. */
function fileName(p: string): string {
  const normalized = String(p).replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * True when a shortcut target is a DEV-LANE Electron binary — i.e. the poison.
 *
 * Deliberately narrow, because this decides whether a user-visible shortcut
 * gets deleted:
 *  - "electron.exe" under an electron/dist folder or a node_modules/electron
 *    tree is the stock Electron binary → poison.
 *  - The branded dev binary ("orplex-dev.exe", a renamed copy of the same
 *    runtime) → ALSO poison. This is the one that mattered: a dev run's toast
 *    shortcut left "Orplex Code.lnk" pointing at orplex-dev.exe, the installer
 *    kept that shortcut, and electron-builder re-launched the app through it
 *    after an update — which started a bare Electron with no app path and
 *    popped the generic Electron window. Treating it as harmless is exactly
 *    why that shortcut survived every sweep.
 *  - An installed "Orplex Code.exe" is NOT poison.
 *  - Anything else (a browser, a game, an unrelated app) is NOT poison.
 */
export function isIconPoisonTarget(target: string | undefined | null): boolean {
  if (!target) return false;
  const t = String(target).replace(/\\/g, "/");
  // Basename must be exactly a dev-lane runtime (not electron, not
  // electron-helper.exe, not the installed product).
  const base = fileName(t);
  if (base !== "electron.exe" && base !== DEV_BINARY_NAME) return false;
  return (
    /\/electron\/dist\/electron\.exe$/i.test(t) ||
    /\/electron\/dist\/orplex-dev\.exe$/i.test(t) ||
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
  /** Paths of our own shortcuts that were repointed instead of deleted. */
  repaired: string[];
  /** Candidates that were inspected but legitimately kept. */
  kept: number;
  /** Error messages from candidates that could not be inspected. */
  errors: string[];
}

/**
 * How to REPAIR — rather than delete — one of our own shortcuts that points at
 * a dev-lane binary.
 *
 * Deleting the app's Start Menu entry is unnecessary in the packaged lane (the
 * entry is legitimately ours, only its target is wrong), and electron-builder
 * re-creates it on install anyway. Repointing it means the shell and the
 * updater can never resolve "Orplex Code" through a dev binary again.
 */
export interface PoisonRepoint {
  /** Absolute path of the executable the shortcut must point at. */
  target: string;
  /** File names (case-insensitive) of OUR app's shortcuts, e.g. "Orplex Code.lnk". */
  shortcutNames: string[];
  /** Rewrite an existing shortcut to `target`. */
  write: (shortcutPath: string, target: string) => void;
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
  /**
   * Packaged lane only: repoint our own poisoned shortcut instead of deleting
   * it. Leave undefined in dev (the dev binary must never be a shortcut target,
   * so there deleting is the right answer).
   */
  repoint?: PoisonRepoint;
}): PoisonSweepResult {
  const removed: string[] = [];
  const repaired: string[] = [];
  const errors: string[] = [];
  let kept = 0;
  const ownNames = (deps.repoint?.shortcutNames ?? []).map((n) => n.toLowerCase());
  // Repointing to ANOTHER dev-lane binary would just recreate the bug (a
  // packaged-mode run straight from a checkout has process.execPath =
  // node_modules\electron\dist\electron.exe). Then deleting stays correct.
  const repoint =
    deps.repoint && !isIconPoisonTarget(deps.repoint.target) ? deps.repoint : undefined;
  for (const candidate of deps.candidates) {
    try {
      if (!deps.exists(candidate)) continue;
      const target = deps.readTarget(candidate);
      if (!isIconPoisonTarget(target)) {
        kept++;
        continue;
      }
      if (repoint && ownNames.includes(fileName(candidate))) {
        repoint.write(candidate, repoint.target);
        repaired.push(candidate);
        continue;
      }
      deps.remove(candidate);
      removed.push(candidate);
    } catch (err) {
      errors.push(String((err as Error)?.message ?? err));
    }
  }
  return { removed, repaired, kept, errors };
}
