/**
 * terminal-format.ts — pure display helpers for the Terminal tab.
 *
 * Shell output arrives as a raw byte stream: ANSI color sequences would
 * render as garbage escape characters in the DOM. The v2 terminal strips
 * them (spec §5.6: "ANSI colour rendering or safe stripping").
 */

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // e.g. ESC[31m, ESC[0K
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // e.g. OSC hyperlinks, titles
const ESC = /\x1b[@-Z\\-_]/g; // single-char escapes (ESC c, ESC \ ...)

/** Strip all ANSI escape sequences from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(ESC, "");
}
