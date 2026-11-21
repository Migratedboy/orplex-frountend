// app-settings.ts — the small set of user preferences that are stored
// browser-locally (localStorage), plus the readers that actually make them do
// something.
//
// Rule for this module: every key here has a consumer. A preference that no
// code reads is a lie in the UI, so it is not added. Current consumers:
//   sounds      -> playFinishedChime() in lib/notifications.ts, called when a
//                  run finishes while the window is not focused
//   autoArchive -> sweepAutoArchive() below, run by ConversationProvider after
//                  the conversation list loads
//
// Browser-local (not the database) because these are renderer behaviours, not
// account state — the same reason shortcut overrides and disabled skills live
// here. Never contains secrets.

export const APP_SETTINGS_KEY = "orplex-settings";
export const APP_SETTINGS_EVENT = "orplex:setting";

export interface AppSettings {
  /** Play a short chime when a run finishes and the window is not focused. */
  sounds: boolean;
  /** Archive chats untouched for this many days. "never" disables the sweep. */
  autoArchive: "never" | "1" | "7" | "30";
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  sounds: true,
  autoArchive: "never",
};

const AUTO_ARCHIVE_VALUES: AppSettings["autoArchive"][] = ["never", "1", "7", "30"];

/** Read settings, tolerating a missing/corrupt blob and unknown old fields. */
export function readAppSettings(): AppSettings {
  if (typeof window === "undefined") return { ...APP_SETTINGS_DEFAULTS };
  try {
    const raw = JSON.parse(window.localStorage.getItem(APP_SETTINGS_KEY) ?? "{}");
    return {
      sounds:
        typeof raw?.sounds === "boolean" ? raw.sounds : APP_SETTINGS_DEFAULTS.sounds,
      autoArchive: AUTO_ARCHIVE_VALUES.includes(raw?.autoArchive)
        ? raw.autoArchive
        : APP_SETTINGS_DEFAULTS.autoArchive,
    };
  } catch {
    return { ...APP_SETTINGS_DEFAULTS };
  }
}

/** Merge a patch into the stored blob and announce it to the renderer. */
export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readAppSettings(), ...patch };
  if (typeof window !== "undefined") {
    try {
      const raw = JSON.parse(window.localStorage.getItem(APP_SETTINGS_KEY) ?? "{}");
      window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ ...raw, ...patch }));
    } catch {
      window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
    }
    window.dispatchEvent(new CustomEvent(APP_SETTINGS_EVENT, { detail: patch }));
  }
  return next;
}

/**
 * Archive conversations whose last activity is older than the configured
 * window. Returns the ids it archived so callers can refresh their list.
 *
 * Archive state itself lives in lib/archived-chats (client-side set), so this
 * is the only place that sweeps: ProviderState calls it once per load, which
 * keeps it idempotent (an already-archived id is skipped).
 */
export function sweepAutoArchive(
  conversations: { id: string; updatedAt: string }[],
  now: number = Date.now()
): string[] {
  const { autoArchive } = readAppSettings();
  if (autoArchive === "never") return [];
  const days = Number(autoArchive);
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = now - days * 86_400_000;
  const ids: string[] = [];
  for (const c of conversations) {
    const t = new Date(c.updatedAt).getTime();
    if (Number.isFinite(t) && t < cutoff) ids.push(c.id);
  }
  return ids;
}
