// dev-mode.ts — one source of truth for "source checkout" vs "installed app".
//
// Why this exists: the dev launcher runs a BRANDED copy of electron.exe
// (scripts/dev-branded-electron.mjs) so the Windows taskbar shows the Orplex
// icon instead of Electron's. A renamed electron binary makes Electron treat
// the process as PACKAGED (app.isPackaged === true), which would send the app
// looking for a standalone server that a checkout doesn't have.
//
// The launcher sets ORPLEX_DEV=1 for the child process, so the app can tell
// "branded dev binary" from "installed product" reliably.

import { app } from "electron";

/** Running from a source checkout (plain electron OR the branded dev binary). */
export function isDevRuntime(): boolean {
  return !app.isPackaged || process.env.ORPLEX_DEV === "1";
}

/** Running as an installed product (what the updater and release paths need). */
export function isPackagedRuntime(): boolean {
  return !isDevRuntime();
}
