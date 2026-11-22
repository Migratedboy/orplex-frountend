/**
 * Theme resolution, shared by the server and the client.
 *
 * `<html class="dark">` is what the server used to send for everybody, so a
 * light-preferring user saw the dark shell for a frame or two until React
 * hydrated — the "it flickers and changes by itself" report. The first attempt
 * fixed that with an inline `<script>` in <head>, which React 19 refuses to run
 * ("Encountered a script tag while rendering React component") — so the theme
 * is now resolved on the SERVER instead: the stored preference is mirrored into
 * this cookie, and the root layout stamps the correct `data-theme` into the
 * HTML it sends. No script, no flash, nothing for React to warn about.
 *
 * Pref model (unchanged): `orplex-theme` is 'light' | 'dark' | 'system';
 * unset = dark (the app's default); 'system' follows the OS on the client.
 */

/** Cookie name. Deliberately identical to the localStorage key. */
export const THEME_COOKIE = "orplex-theme";

export type Theme = "light" | "dark";

/** What the server paints when there is no cookie: the app's dark default. */
export const DEFAULT_THEME: Theme = "dark";

/**
 * Server-side resolution. Only an explicit "light" renders light — 'system'
 * cannot be resolved without the OS, so it takes the default and the client
 * corrects it on the next boot (and immediately writes the resolved cookie).
 */
export function resolveTheme(value: string | null | undefined): Theme {
  return value === "light" ? "light" : DEFAULT_THEME;
}

/** Attributes the root layout puts on <html> for a resolved theme. */
export function themeAttributes(theme: Theme): {
  className: string | undefined;
  "data-theme": Theme;
  "data-theme-ready": string;
} {
  return {
    className: theme === "dark" ? "dark" : undefined,
    "data-theme": theme,
    "data-theme-ready": "1",
  };
}

/** One year; the preference is a device setting, not a session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Mirror the resolved theme into the cookie the server reads at request time.
 * localStorage stays the source of truth for the running client; this is the
 * copy that makes the NEXT page load paint correctly on the first frame.
 */
export function syncThemeCookie(resolved: Theme): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${THEME_COOKIE}=${resolved}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // Cookies unavailable (hardened context): the client still resolves the
    // theme from localStorage, only the next load's first frame is dark.
  }
}
