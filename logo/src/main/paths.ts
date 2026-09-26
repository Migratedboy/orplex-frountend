import path from 'node:path';

/** Resolves runtime asset locations relative to the compiled main bundle. */

export const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');

/** dist/ root. */
export const DIST_DIR = path.resolve(__dirname, '..');

/**
 * Renderer pages are served over the privileged "app" scheme so ES modules
 * work (file:// pages cannot load modules due to CORS). Compiled layout:
 *   dist/renderer/renderer/<page>.html  (HTML + CSS copied here)
 *   dist/renderer/renderer/<page>.js    (tsc emit)
 *   dist/renderer/shared/<module>.js    (tsc emit, imported as ../shared/…)
 */
export const APP_PAGES_ROOT = path.join(DIST_DIR, 'renderer');

/** Standard host for the app scheme; path maps under APP_PAGES_ROOT. */
export function rendererURL(page: string): string {
  return `app://r/renderer/${page}`;
}

export const MAIN_DIR = __dirname;
