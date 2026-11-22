/**
 * Pre-paint theme bootstrap.
 *
 * `<html class="dark">` is what the server sends, so a light-preferring user
 * used to see the dark shell for a frame or two until React hydrated and
 * ThemeInit's effect flipped the attributes — the "it flickers and changes by
 * itself" report. This snippet runs synchronously in <head>, before the first
 * paint, and sets the SAME attributes ThemeInit/ThemeProvider keep in sync
 * afterwards, so the first frame is already correct.
 *
 * Rules (identical to ThemeProvider):
 *   - stored pref `orplex-theme` is 'light' | 'dark' | 'system'
 *   - no stored value  → dark (the app's default)
 *   - 'system'         → follow prefers-color-scheme
 * It also drops a `data-theme-ready` marker so CSS can hold back transitions
 * until the theme has been resolved once.
 */
export const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("orplex-theme")||"dark";var d=p!=="light"&&(p!=="system"||window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.classList.toggle("dark",d);r.dataset.themeReady="1";}catch(e){void e}})();`;

export default THEME_BOOTSTRAP;
