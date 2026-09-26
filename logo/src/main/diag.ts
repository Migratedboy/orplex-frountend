import type { BrowserWindow } from 'electron';

/** Forwards renderer console errors to the main-process log. */
export function attachConsoleDiagnostics(win: BrowserWindow, tag: string): void {
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[${tag}:console] ${message} (${sourceId}:${line})`);
    }
  });
}

/**
 * Evaluates in a renderer after load: verifies the stylesheet actually applied
 * (circle radius), the body is transparent (window chrome working), and the
 * preload bridge is present (module scripts executed).
 */
export const RENDER_HEALTHCHECK_JS = `(async () => {
  // Small settle delay: async pieces (logo IPC) land right after load.
  await new Promise((r) => setTimeout(r, 800));
  const circle = document.getElementById('circle');
  if (!circle) return JSON.stringify({ ok: false, reason: 'no #circle element' });
  const cs = getComputedStyle(circle);
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const logo = document.getElementById('logo');
  const sheets = Array.from(document.styleSheets).length;
  const bridge = typeof window.focuslock === 'object' && window.focuslock !== null;
  let logoProbe = 'no-bridge';
  if (bridge) {
    try {
      const dataUrl = await window.focuslock.getLogoDataUrl();
      logoProbe = dataUrl === null ? 'null' : 'ok:' + dataUrl.slice(0, 30);
    } catch (err) {
      logoProbe = 'throw:' + String(err).slice(0, 80);
    }
  }
  return JSON.stringify({
    ok: cs.borderRadius === '50%' && bodyBg === 'rgba(0, 0, 0, 0)' && bridge,
    borderRadius: cs.borderRadius,
    bodyBg,
    sheets,
    bridge,
    logoSrc: logo && logo.src ? logo.src.slice(0, 40) : null,
    logoProbe,
    logoFlag: document.body.dataset['logo'] ?? 'unset',
    glowFlag: document.body.dataset['glow'] ?? 'unset',
    bootFlag: document.body.dataset['boot'] ?? 'unset',
    specFlag: document.body.dataset['spec'] ?? 'unset'
  });
})()`;

/** Runs the healthcheck and logs a single PASS/FAIL line. */
export function runRenderHealthcheck(win: BrowserWindow, tag: string): void {
  win.webContents.on('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(RENDER_HEALTHCHECK_JS)
      .then((raw: unknown) => {
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        console.log(`[diag:${tag}] ${text}`);
      })
      .catch((err: unknown) => {
        console.error(`[diag:${tag}] healthcheck failed:`, err);
      });
  });
}
