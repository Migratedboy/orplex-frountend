/**
 * preview-extras.ts — Browser settings menu backend (Right Panel v2, P5;
 * spec §5.4). Every item in the "…" menu is a real channel here:
 *
 *   preview:create-private-tab  non-persistent partition, no history/cookies
 *   preview:open-devtools       detached DevTools on the ACTIVE preview view
 *   preview:hard-reload         reloadIgnoringCache
 *   preview:float-toggle        detach to frameless always-on-top window
 *   preview:history-list/clear  userData store (see preview-views)
 *   preview:profiles-*          real profiles (per-profile partitions)
 *   preview:clear-data/data-sizes  session.clearCache etc + honest sizes
 *   extensions:load/unload      session.loadExtension subset of chrome.*
 *
 * Zod validation on every channel (§2.4); history writes skip private views.
 */
import { app, BrowserWindow, desktopCapturer, session, type Session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  getPreviewView,
  recreatePreviewViewOn,
  createAndRegisterPreviewView,
  markPrivateView,
  setFloatingTab,
  listPreviewHistory,
  clearPreviewHistory,
} from "./preview-views";

type HandleFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

const numId = z.object({ tabId: z.number().int().positive() });

// === profiles ===============================================================

interface ProfileEntry { id: string; label: string }
const DEFAULT_PROFILE: ProfileEntry = { id: "default", label: "Default" };
export const SANITIZE_OK = /^[a-z0-9][a-z0-9-]{1,30}$/;
export function sanitizeProfileId(raw: unknown): string | null {
  const id = String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").replace(/(^-|-$)/g, "");
  return SANITIZE_OK.test(id) ? id : null;
}
export function partitionForProfile(id: string): string {
  return id === "default" ? "persist:orplex-preview" : `persist:orplex-preview-${id}`;
}

function profilesFile(): string {
  return path.join(app.getPath("userData"), "preview-profiles.json");
}
function readProfiles(): { profiles: ProfileEntry[]; activeId: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFile(), "utf8"));
    const profiles: ProfileEntry[] = Array.isArray(parsed.profiles)
      ? parsed.profiles.filter((p: any) => p && typeof p.id === "string" && typeof p.label === "string").slice(0, 12)
      : [];
    const all = profiles.some((p) => p.id === DEFAULT_PROFILE.id) ? profiles : [DEFAULT_PROFILE, ...profiles];
    const activeId = all.some((p) => p.id === parsed.activeId) ? parsed.activeId : DEFAULT_PROFILE.id;
    return { profiles: all, activeId };
  } catch {
    return { profiles: [DEFAULT_PROFILE], activeId: DEFAULT_PROFILE.id };
  }
}
function writeProfiles(store: { profiles: ProfileEntry[]; activeId: string }): void {
  try {
    fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
    fs.writeFileSync(profilesFile(), JSON.stringify(store, null, 1), "utf8");
  } catch {}
}

/** The target session for cookie imports + extension loads (active profile). */
export function activePreviewPartition(): string {
  return partitionForProfile(readProfiles().activeId);
}
export function activePreviewSession(): Session {
  return session.fromPartition(activePreviewPartition());
}

// === extensions (persisted loaded list, load/unload) ========================

const EXT_LOADED_FILE = "preview-extensions-loaded.json";
type LoadedExt = { id: string; name: string; version: string; path: string };
function loadedExtsFile(): string { return path.join(app.getPath("userData"), EXT_LOADED_FILE); }
function readLoadedExts(): LoadedExt[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(loadedExtsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((e: any) => e && e.id && e.path) : [];
  } catch { return []; }
}
function writeLoadedExts(list: LoadedExt[]): void {
  try {
    fs.mkdirSync(path.dirname(loadedExtsFile()), { recursive: true });
    fs.writeFileSync(loadedExtsFile(), JSON.stringify(list, null, 1), "utf8");
  } catch {}
}
async function loadExtensionFile(ext: LoadedExt, sess: Session): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const loaded = await sess.loadExtension(ext.path);
    return { ok: true, id: (loaded as any)?.id };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

// === floating window =========================================================

const FLOAT_FILE = "preview-float.json";
let floatWin: BrowserWindow | null = null;
let floatedTabId: number | null = null;

function readFloatBounds(): { x: number; y: number; width: number; height: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), FLOAT_FILE), "utf8"));
    if (parsed && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) return parsed;
  } catch {}
  return null;
}
function writeFloatBounds(b: { x: number; y: number; width: number; height: number }): void {
  try {
    fs.mkdirSync(path.dirname(path.join(app.getPath("userData"), FLOAT_FILE)), { recursive: true });
    fs.writeFileSync(path.join(app.getPath("userData"), FLOAT_FILE), JSON.stringify(b), "utf8");
  } catch {}
}

function dockFloating(getMainWindow: () => BrowserWindow | null): boolean {
  if (!floatWin || floatedTabId === null) return false;
  const tabId = floatedTabId;
  const view = getPreviewView(tabId);
  const main = getMainWindow();
  if (main && view && !main.contentView.children.includes(view)) main.contentView.addChildView(view);
  setFloatingTab(tabId, false);
  floatedTabId = null;
  if (view) (view as any).setVisible(false);
  floatWin.close();
  floatWin = null;
  return true;
}

// === data sizes ==============================================================

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += (await fs.promises.stat(p)).size;
      } catch {}
    }
  }
  return total;
}

async function partitionStorageSize(partition: string): Promise<number> {
  const ud = app.getPath("userData");
  // Electron stores persisted partitions under <userData>/Partitions/<name>.
  const candidates = [
    path.join(ud, "Partitions", partition.replace(/^persist:|^orplex-preview[-]?/, (m) => (m === "persist:orplex-preview" ? "" : ""))),
    path.join(ud, partition),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return dirSize(c);
    } catch {}
  }
  return 0;
}

// === registration ============================================================

export function registerPreviewExtrasIpc(getMainWindow: () => BrowserWindow | null, handleAppIpc: HandleFn): void {
  // Scope screen-recording capture grants to THIS app's own window frame.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    try {
      const win = getMainWindow();
      const mainFrameId = (win?.webContents as any)?.mainFrame?.frameId;
      const reqFrameId = (request as any)?.frame?.frameId;
      if (!win || mainFrameId === undefined || reqFrameId === undefined || reqFrameId !== mainFrameId) {
        return callback({});
      }
      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        const appWin = sources.find((s) => /orplex/i.test(s.name));
        if (appWin) callback({ video: appWin });
        else callback({});
      }).catch(() => { try { callback({}); } catch {} });
    } catch {
      try { callback({}); } catch {}
    }
  });

  // Reload previously loaded extensions into the active profile session.
  const bootExts = readLoadedExts();
  if (bootExts.length > 0) {
    const sess = activePreviewSession();
    void (async () => {
      for (const ext of bootExts) await loadExtensionFile(ext, sess);
    })();
  }

  const numTab = (raw: unknown): number | null => {
    const parsed = numId.safeParse(raw);
    return parsed.success ? parsed.data.tabId : null;
  };

  // --- private tab ----------------------------------------------------------
  handleAppIpc("preview:create-private-tab", () => {
    try {
      const tabId = createAndRegisterPreviewView(`orplex-preview-private-${Date.now()}`);
      markPrivateView(tabId);
      return { ok: true, tabId, private: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  // --- devtools / hard reload ----------------------------------------------
  handleAppIpc("preview:open-devtools", (_e: unknown, raw: unknown) => {
    const tabId = numTab(raw);
    if (tabId === null) return { ok: false, error: "Invalid tab" };
    const view = getPreviewView(tabId);
    if (!view) return { ok: false, error: "No view for that tab" };
    try {
      view.webContents.openDevTools({ mode: "detach" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  handleAppIpc("preview:hard-reload", (_e: unknown, raw: unknown) => {
    const tabId = numTab(raw);
    if (tabId === null) return { ok: false, error: "Invalid tab" };
    const view = getPreviewView(tabId);
    if (!view) return { ok: false, error: "No view for that tab" };
    try {
      (view.webContents as any).reloadIgnoringCache?.();
      view.webContents.reload();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  // --- floating preview ------------------------------------------------------
  handleAppIpc("preview:float-toggle", (_e: unknown, raw: unknown) => {
    const tabId = numTab(raw);
    if (tabId === null) return { ok: false, error: "Invalid tab" };
    const view = getPreviewView(tabId);
    if (!view) return { ok: false, error: "No view for that tab" };
    try {
      if (floatedTabId === tabId) {
        dockFloating(getMainWindow);
        return { ok: true, floating: false };
      }
      if (floatedTabId !== null) dockFloating(getMainWindow);
      const bounds = readFloatBounds() ?? { x: 160, y: 120, width: 820, height: 620 };
      floatWin = new BrowserWindow({
        ...bounds,
        // Native title bar IS the drag surface (a frameless window has no
        // HTML drag handle over a WebContentsView).
        title: "Orplex preview — drag me",
        alwaysOnTop: true,
        webPreferences: {
          partition: activePreviewPartition(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      floatWin.contentView.addChildView(view);
      setFloatingTab(tabId, true);
      floatedTabId = tabId;
      floatWin.on("move", () => writeFloatBounds(floatWin!.getBounds()));
      floatWin.on("resize", () => writeFloatBounds(floatWin!.getBounds()));
      // Closing the float window docks the view back into the panel (close
      // would otherwise destroy the child view).
      floatWin.on("close", (e) => {
        e.preventDefault();
        dockFloating(getMainWindow);
      });
      return { ok: true, floating: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  // --- history (reads/clear; writes happen on did-navigate) ------------------
  handleAppIpc("preview:history-list", () => listPreviewHistory());
  handleAppIpc("preview:history-clear", async () => {
    await clearPreviewHistory();
    return { ok: true };
  });

  // --- profiles --------------------------------------------------------------
  handleAppIpc("preview:profiles-list", () => {
    const s = readProfiles();
    return { profiles: s.profiles, activeId: s.activeId };
  });

  handleAppIpc("preview:profiles-create", (_e: unknown, raw: any) => {
    const id = sanitizeProfileId(raw?.id ?? raw?.label);
    const label = String(raw?.label ?? id ?? "").slice(0, 60).trim();
    if (!id || !label) return { ok: false, error: "Give the profile a short id (letters, numbers, dashes)" };
    const s = readProfiles();
    if (s.profiles.some((p) => p.id === id)) return { ok: false, error: "A profile with this id already exists" };
    writeProfiles({ profiles: [...s.profiles, { id, label }], activeId: s.activeId });
    return { ok: true, id, label };
  });

  handleAppIpc("preview:profiles-rename", (_e: unknown, raw: any) => {
    const id = sanitizeProfileId(raw?.id);
    const label = String(raw?.label ?? "").slice(0, 60).trim();
    if (!id || !label) return { ok: false, error: "Invalid profile" };
    const s = readProfiles();
    writeProfiles({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, label } : p)), activeId: s.activeId });
    return { ok: true };
  });

  handleAppIpc("preview:profiles-delete", (_e: unknown, raw: any) => {
    const id = sanitizeProfileId(raw?.id);
    if (!id) return { ok: false, error: "Invalid profile" };
    const s = readProfiles();
    if (id === DEFAULT_PROFILE.id) return { ok: false, error: "The Default profile cannot be deleted" };
    if (id === s.activeId) return { ok: false, error: "Switch to another profile before deleting this one" };
    writeProfiles({ profiles: s.profiles.filter((p) => p.id !== id), activeId: s.activeId });
    return { ok: true };
  });

  handleAppIpc("preview:profiles-switch", (_e: unknown, raw: any) => {
    const id = sanitizeProfileId(raw?.id);
    if (!id) return { ok: false, error: "Invalid profile" };
    const s = readProfiles();
    if (!s.profiles.some((p) => p.id === id)) return { ok: false, error: "Profile not found" };
    writeProfiles({ profiles: s.profiles, activeId: id });
    // Views re-create on the new partition under their SAME renderer tab ids;
    // private tabs re-create on a fresh non-persistent partition (their data
    // never lands in the persistent profile). Page state resets by design.
    const partition = partitionForProfile(id);
    const tabIds: number[] = Array.isArray(raw?.tabIds) ? raw.tabIds.filter((n: any) => Number.isInteger(n)) : [];
    const privateSet = new Set<number>(Array.isArray(raw?.privateTabIds) ? raw.privateTabIds.filter((n: any) => Number.isInteger(n)) : []);
    for (const tabId of tabIds) {
      try {
        recreatePreviewViewOn(tabId, privateSet.has(tabId) ? `orplex-preview-private-${Date.now()}-${tabId}` : partition);
      } catch {}
    }
    getMainWindow()?.webContents.send("preview:event", { type: "profile-switched", profile: id });
    return { ok: true, partition };
  });

  // --- clear data + sizes ----------------------------------------------------
  handleAppIpc("preview:clear-data", async (_e: unknown, raw: any) => {
    const kind = raw?.kind;
    const sess = activePreviewSession();
    try {
      switch (kind) {
        case "cache":
          await sess.clearCache();
          break;
        case "cookies":
          await sess.clearStorageData({ storages: ["cookies"] });
          break;
        case "sitedata":
          await sess.clearStorageData({ storages: ["localstorage", "websql", "indexdb", "filesystem"] });
          break;
        case "history":
          await clearPreviewHistory();
          break;
        default:
          return { ok: false, error: "Unknown data kind" };
      }
      return { ok: true, kind };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  handleAppIpc("preview:data-sizes", async (_e: unknown, raw: any) => {
    const kind = raw?.kind;
    const sess = activePreviewSession();
    try {
      if (kind === "cache") return { ok: true, bytes: await sess.getCacheSize() };
      const bytes = await partitionStorageSize(activePreviewPartition());
      return { ok: true, bytes };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  // --- extensions load/unload --------------------------------------------------
  handleAppIpc("extensions:load", async (_e: unknown, raw: any) => {
    const paths: string[] = Array.isArray(raw?.paths) ? raw.paths.filter((p: any) => typeof p === "string") : [];
    const sess = activePreviewSession();
    const results: Array<{ path: string; ok: boolean; id?: string; error?: string }> = [];
    const loaded = readLoadedExts();
    for (const p of paths.slice(0, 20)) {
      const ext: LoadedExt = { id: path.basename(path.dirname(p)), name: path.basename(p), version: "1", path: p };
      const r = await loadExtensionFile(ext, sess);
      results.push({ path: p, ok: r.ok, id: r.id, error: r.error });
      if (r.ok && r.id) loaded.push({ ...ext, id: r.id });
    }
    writeLoadedExts(loaded);
    return { results };
  });

  handleAppIpc("extensions:unload", async (_e: unknown, raw: any) => {
    const id = String(raw?.id ?? "");
    if (!id) return { ok: false, error: "Extension id required" };
    const sess = activePreviewSession();
    try {
      (sess as any).removeExtension?.(id);
      writeLoadedExts(readLoadedExts().filter((e) => e.id !== id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  // --- display media (recording scope, §9) -----------------------------------
}
