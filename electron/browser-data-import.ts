/**
 * browser-data-import.ts — Import-browser-data dialog backend (Right Panel
 * v2, P5; spec §5.5; DECISIONS D6).
 *
 * - detectBrowsers: Chrome/Edge/Brave (Chromium) + Firefox with profile
 *   labels (Chromium Local State → profile.info_cache).
 * - Cookies & sign-ins: Firefox plaintext `cookies.sqlite`; Chromium copies
 *   the (locked) DB, reads it with `node:sqlite`, decrypts v10 AES-256-GCM
 *   with the DPAPI-unprotected Local State key. v20 (App-Bound Encryption,
 *   Chrome 127+) is NEVER bypassed — rows are counted as protected/skipped
 *   and the dialog shows the honest cookie-file notice.
 * - Extensions: enumerated `Extensions/<id>/<version>/manifest.json` with
 *   `__MSG_*__` names resolved from `_locales`.
 * - Cookie files: Netscape `cookies.txt` + Cookie-Editor JSON parsers.
 *
 * Privacy contract (§2.6): cookie values/tokens are never logged, never
 * written outside the Electron session store, never sent anywhere. Every log
 * line below carries counts or labels only.
 */
import { app, dialog, type BrowserWindow, type Session } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { safeConsoleWrite } from "./safe-io";

// node:sqlite — probed once (D6). If the runtime lacks it, cookie imports
// degrade to the cookie-file path with an honest notice (nothing silently fails).
let sqlite: any = null;
try {
  const req = createRequire("electron/main");
  sqlite = req("node:sqlite");
} catch { /* feature detected per call */ }

export function sqliteAvailable(): boolean {
  return !!sqlite?.DatabaseSync;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: Date;
  sameSite?: "no_restriction" | "lax" | "strict";
}

export interface DetectedExtension {
  id: string;
  name: string;
  version: string;
  /** Absolute version dir (copy source). */
  dir: string;
}

export interface DetectedProfile {
  id: "chrome" | "edge" | "brave" | "firefox";
  name: string;
  profileLabel: string;
  profileDir: string;
  kind: "chromium" | "firefox";
  cookiesDecryptable: boolean;
  cookiesBlockedReason?: string;
  hasAppBoundCookies: boolean;
  extensions: DetectedExtension[];
}

// === Browser detection =====================================================

function roots(): Array<{ id: DetectedProfile["id"]; name: string; base: string }> {
  const p = process.platform;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const home = os.homedir();
  if (p === "win32") {
    return [
      { id: "chrome", name: "Chrome", base: path.join(local, "Google", "Chrome", "User Data") },
      { id: "edge", name: "Edge", base: path.join(local, "Microsoft", "Edge", "User Data") },
      { id: "brave", name: "Brave", base: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
    ];
  }
  if (p === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    return [
      { id: "chrome", name: "Chrome", base: path.join(appSupport, "Google", "Chrome") },
      { id: "edge", name: "Edge", base: path.join(appSupport, "Microsoft Edge") },
      { id: "brave", name: "Brave", base: path.join(appSupport, "BraveSoftware", "Brave-Browser") },
    ];
  }
  const config = path.join(home, ".config");
  return [
    { id: "chrome", name: "Chrome", base: path.join(config, "google-chrome") },
    { id: "edge", name: "Edge", base: path.join(config, "microsoft-edge") },
    { id: "brave", name: "Brave", base: path.join(config, "BraveSoftware", "Brave-Browser") },
  ];
}

function firefoxBase(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles");
  return path.join(os.homedir(), ".mozilla", "firefox");
}

/** Default profile label from Chromium Local State → profile.info_cache. */
export function readLocalStateProfileName(dir: string, fallback: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, "Local State"), "utf8");
    const json = JSON.parse(raw);
    const info = json?.profile?.info_cache;
    if (info && typeof info === "object") {
      const entries = Object.entries(info) as Array<[string, any]>;
      const def = info[json.profile.last_used || ""] ?? entries[0]?.[1];
      if (def?.name && typeof def.name === "string") return String(def.name).slice(0, 60);
    }
  } catch {}
  return fallback;
}

/** Enumerate Extensions/<id>/<version>/manifest.json with __MSG__ names. */
export function enumerateExtensions(profileDir: string): DetectedExtension[] {
  const base = path.join(profileDir, "Extensions");
  let ids: string[] = [];
  try { ids = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out: DetectedExtension[] = [];
  for (const id of ids) {
    try {
      const versions = fs.readdirSync(path.join(base, id)).sort().reverse();
      const version = versions[0];
      if (!version) continue;
      const dir = path.join(base, id, version);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      let name = typeof manifest.name === "string" ? manifest.name : id;
      const msgMatch = name.match(/^__MSG_(.+?)__$/i);
      if (msgMatch) {
        const locale = path.join(dir, "_locales", "en", "messages.json");
        try {
          const messages = JSON.parse(fs.readFileSync(locale, "utf8")) as Record<string, { message?: string }>;
          const resolved = messages[msgMatch[1]]?.message;
          if (resolved) name = stripped(resolved);
        } catch {}
      }
      out.push({ id, name: stripped(name) || id, version, dir });
    } catch {
      // No manifest — skip (not an importable extension).
    }
  }
  return out;
}

function stripped(s: string): string {
  return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function detectBrowsers(): DetectedProfile[] {
  const out: DetectedProfile[] = [];
  for (const r of roots()) {
    if (!fs.existsSync(r.base)) continue;
    // Pick the first profile dir with a Local State/Preferences pair.
    let profileDir: string | null = null;
    let label = "Default";
    try {
      const cand = fs.readdirSync(r.base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(r.base, d.name));
      for (const c of cand) {
        if (fs.existsSync(path.join(c, "Preferences")) || fs.existsSync(path.join(c, "Secure Preferences"))) {
          profileDir = c;
          label = readLocalStateProfileName(r.base, c.endsWith("Default") ? "Default" : path.basename(c));
          break;
        }
      }
      if (!profileDir && fs.existsSync(path.join(r.base, "Default"))) {
        profileDir = path.join(r.base, "Default");
      }
    } catch {}
    if (!profileDir) continue;
    const decryptable = sqliteAvailable() && process.platform === "win32";
    out.push({
      id: r.id,
      name: r.name,
      profileLabel: label,
      profileDir,
      kind: "chromium",
      cookiesDecryptable: decryptable,
      cookiesBlockedReason: !sqliteAvailable()
        ? "This build has no cookie reader — use Import cookie file…"
        : process.platform !== "win32"
          ? "Cookie import needs the Windows credential store on this machine"
          : undefined,
      hasAppBoundCookies: false, // resolved per-import (v20 counted there)
      extensions: enumerateExtensions(profileDir),
    });
  }

  // Firefox (plaintext cookies.sqlite).
  const ffBase = firefoxBase();
  try {
    const profiles = fs.readdirSync(ffBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const prefs = fs.existsSync(path.join(ffBase, "profiles.ini")) ? fs.readFileSync(path.join(ffBase, "profiles.ini"), "utf8") : "";
    let chosen = profiles[0];
    const rel = prefs.match(/Path=(.+)/)?.[1]?.trim().replace(/\\/g, "/");
    if (rel && profiles.includes(rel.split("/").pop() ?? "")) chosen = rel.split("/").pop()!;
    if (chosen) {
      const dir = path.join(ffBase, chosen);
      const decryptable = sqliteAvailable();
      out.push({
        id: "firefox",
        name: "Firefox",
        profileLabel: chosen.slice(0, 8) + (chosen.length > 8 ? "…" : ""),
        profileDir: dir,
        kind: "firefox",
        cookiesDecryptable: decryptable,
        cookiesBlockedReason: !sqliteAvailable() ? "This build has no cookie reader — use Import cookie file…" : undefined,
        hasAppBoundCookies: false,
        extensions: [],
      });
    }
  } catch {}

  return out;
}

// === Cookie parsers (pure, tested) =========================================

/** Netscape cookies.txt: `domain\tflag\tpath\tsecure\texpiry\tname\tvalue`. */
export function parseNetscapeCookies(text: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    let t = line.trim();
    if (!t) continue;
    // HttpOnly cookies are exported with a `#HttpOnly_` domain prefix (still
    // a data line, not a comment) — must be stripped BEFORE the #-comment check.
    let prefixHttpOnly = false;
    if (t.startsWith("#HttpOnly_")) {
      t = t.slice("#HttpOnly_".length);
      prefixHttpOnly = true;
    }
    if (t.startsWith("#")) continue;
    const parts = t.split("\t");
    if (parts.length < 7) continue;
    const [domainRaw, _flag, pathPart, secure, expiry, name, ...valueParts] = parts;
    let domain = domainRaw.trim();
    const httpOnly = prefixHttpOnly;
    const value = valueParts.join("\t");
    const exp = Number(expiry);
    out.push({
      name: name.trim(),
      value,
      domain,
      path: pathPart.trim() || "/",
      secure: /^true$/i.test(secure),
      httpOnly,
      ...(Number.isFinite(exp) && exp > 0 ? { expires: new Date(exp * 1000) } : {}),
    });
  }
  return out;
}

/** Cookie-Editor / EditThisCookie JSON export shape. */
export function parseCookieEditorJson(text: string): CookieRecord[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: CookieRecord[] = [];
  for (const c of parsed as Array<Record<string, any>>) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
    const domain = typeof c.domain === "string" ? c.domain : "";
    const exp = typeof c.expirationDate === "number" ? c.expirationDate : c.expiry;
    out.push({
      name: c.name,
      value: c.value,
      domain,
      path: typeof c.path === "string" ? c.path : "/",
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      ...(typeof exp === "number" && exp > 0 ? { expires: new Date(exp * 1000) } : {}),
      ...(c.sameSite === "lax" || c.sameSite === "strict" || c.sameSite === "no_restriction" ? { sameSite: c.sameSite } : {}),
    });
  }
  return out;
}

// === Chromium / Firefox DB reads (node:sqlite, D6) =========================

/** Shared-read copy of a locked SQLite DB (Chrome locks Cookies while open). */
async function copyDbFiles(dbPath: string, dir: string): Promise<string> {
  const dest = path.join(dir, "cookies.db");
  await fs.promises.copyFile(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    await fs.promises.copyFile(dbPath + suffix, dest + suffix).catch(() => {});
  }
  return dest;
}

function pickColumns(cols: string[], wanted: string[], table: string, db: any): string {
  const real = new Set(cols);
  for (const w of wanted) if (!real.has(w)) throw new Error(`sqlite: ${table} has no column "${w}"`);
  return wanted.join(", ");
}

/** Decrypt one Chromium value (v10, AES-256-GCM, salt=nonce(12) prefix). */
export function decryptChromiumValue(prefix: string, data: Buffer, key: Buffer): string | null {
  if (prefix === "v20") return null; // App-Bound Encryption — never attempted
  if (prefix !== "v10" && prefix !== "v11" && prefix !== "") return null;
  try {
    const nonce = data.subarray(0, 12);
    const ciphertext = data.subarray(12, -16);
    const tag = data.subarray(-16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/** DPAPI-unprotect the Local State os_crypt key (Windows, CurrentUser scope). */
export function unprotectLocalStateKey(localState: any): Buffer | null {
  try {
    const b64 = localState?.os_crypt?.encrypted_key;
    if (typeof b64 !== "string") return null;
    const buf = Buffer.from(b64, "base64");
    const payload = buf.subarray(buf[0] === 0x44 && buf[1] === 0x50 ? 5 : 0); // strip "DPAPI"
    const tmp = path.join(os.tmpdir(), `orplex-key-${randomBytes(4).toString("hex")}`);
    const out = tmp + ".out";
    fs.writeFileSync(tmp, payload);
    const script = `
      Add-Type -AssemblyName System.Security.Cryptography;
      $bytes = [System.IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}');
      try {
        $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser');
        [System.IO.File]::WriteAllBytes('${out.replace(/'/g, "''")}', $plain);
      } catch { exit 1 }
    `;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore", timeout: 15000 });
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    try {
      const key = fs.readFileSync(out);
      fs.unlinkSync(out);
      return key;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function readLocalState(profileDir: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, "Local State"), "utf8"));
  } catch {
    return null;
  }
}

function toCookie(row: Record<string, any>, value: string): CookieRecord | null {
  const name = row.name;
  const host = row.host_key;
  if (typeof name !== "string" || typeof host !== "string") return null;
  const utc = Number(row.expires_utc ?? row.expiration_utc ?? 0);
  const micros = utc;
  const expires = micros > 0 ? new Date((micros - 11644473600000000) / 1000) : undefined;
  const sameSiteInt = Number(row.samesite ?? 0);
  const sameSite = sameSiteInt === 1 ? "lax" : sameSiteInt === 2 ? "strict" : sameSiteInt === -1 ? "no_restriction" : undefined;
  return {
    name,
    value,
    domain: host,
    path: typeof row.path === "string" ? row.path : "/",
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    ...(expires && !isNaN(expires.getTime()) ? { expires } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

/** Read a Chromium Cookies DB (any local state dir containing it). */
export async function readChromiumCookies(dbPath: string, localState: any): Promise<{ cookies: CookieRecord[]; protectedCount: number; failed: number }> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orplex-cookies-"));
  try {
    const copy = await copyDbFiles(dbPath, tmp);
    const key = unprotectLocalStateKey(localState);
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    let cols: string[] = [];
    try {
      const info = db.prepare("PRAGMA table_info(cookies)").all() as Array<Record<string, any>>;
      cols = info.map((r) => String(r.name));
    } catch {}
    const sel = pickColumns(cols, ["name", "path", "host_key", "encrypted_value", "is_secure", "is_httponly", "expires_utc", "expiration_utc", "samesite"].filter((c) => cols.length === 0 || cols.includes(c)), "cookies", db);
    const rows = db.prepare(`SELECT ${sel} FROM cookies`).all() as Array<Record<string, any>>;

    const cookies: CookieRecord[] = [];
    let protectedCount = 0;
    let failed = 0;
    for (const row of rows) {
      const enc = row.encrypted_value;
      let value: string | null = null;
      if (enc === null || enc === undefined) {
        value = typeof row.value === "string" ? row.value : null; // old plaintext-style rows
      } else {
        const buf = Buffer.from(enc as Uint8Array);
        const prefix = buf.subarray(0, 3).toString("ascii");
        if (prefix === "v20") { protectedCount++; continue; }
        if (!key) { protectedCount++; continue; }
        value = decryptChromiumValue(prefix, buf.subarray(3), key);
      }
      const out = value !== null ? toCookie(row, value) : null;
      if (out) cookies.push(out);
      else failed++;
    }
    db.close();
    return { cookies, protectedCount, failed };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read Firefox's plaintext moz_cookies table. */
export async function readFirefoxCookies(dbPath: string): Promise<{ cookies: CookieRecord[]; protectedCount: number; failed: number }> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orplex-cookies-"));
  try {
    const copy = path.join(tmp, "cookies.db");
    await fs.promises.copyFile(dbPath, copy);
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    const info = db.prepare("PRAGMA table_info(moz_cookies)").all() as Array<Record<string, any>>;
    const cols = new Set(info.map((r) => String(r.name)));
    const sel = pickColumns([...cols], ["name", "value", "host", "path", "isSecure", "expiry", "nsExpirationStatus"].filter((c) => cols.has(c)), "moz_cookies", db);
    const rows = db.prepare(`SELECT ${sel} FROM moz_cookies`).all() as Array<Record<string, any>>;
    const cookies: CookieRecord[] = [];
    for (const row of rows) {
      if (typeof row.name !== "string" || typeof row.host !== "string") continue;
      cookies.push({
        name: row.name,
        value: typeof row.value === "string" ? row.value : "",
        domain: row.host,
        path: typeof row.path === "string" ? row.path : "/",
        secure: row.isSecure === 1,
        httpOnly: false,
        ...(typeof row.expiry === "number" && row.expiry > 0 ? { expires: new Date(row.expiry * 1000) } : {}),
      });
    }
    db.close();
    return { cookies, protectedCount: 0, failed: 0 };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Push cookies into a session partition (WebKit epoch already converted). */
export async function importCookiesIntoSession(
  session: Session,
  cookies: CookieRecord[]
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  for (const c of cookies) {
    try {
      const host = c.domain.replace(/^\./, "");
      if (!host) { failed++; continue; }
      const url = `${c.secure ? "https" : "http"}://${host}${c.path.startsWith("/") ? c.path : "/"}`;
      await session.cookies.set({
        url,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.expires ? { expirationDate: c.expires.getTime() / 1000 } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      });
      imported++;
    } catch {
      failed++;
    }
  }
  return { imported, failed };
}

// === Extension copy (to userData/extensions/<id>/ for session.loadExtension) =

export async function copyExtensions(targetDir: string, list: DetectedExtension[]): Promise<{ copied: number; failed: number }> {
  let copied = 0;
  let failed = 0;
  for (const ext of list) {
    try {
      const dest = path.join(targetDir, ext.id);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.mkdir(dest, { recursive: true });
      await fs.promises.cp(ext.dir, dest, { recursive: true });
      copied++;
    } catch {
      failed++;
    }
  }
  return { copied, failed };
}

// === Content-file import (Netscape / Cookie-Editor) =======================

async function pickCookieFile(getMainWindow: () => BrowserWindow | null): Promise<string[]> {
  const win = getMainWindow();
  const r = win
    ? await dialog.showOpenDialog(win, {
        title: "Select a cookie file",
        properties: ["openFile"],
        filters: [{ name: "Cookie files", extensions: ["txt", "json"] }],
      })
    : await dialog.showOpenDialog({
        title: "Select a cookie file",
        properties: ["openFile"],
        filters: [{ name: "Cookie files", extensions: ["txt", "json"] }],
      });
  return r.canceled ? [] : r.filePaths;
}

/** Register browser-data:* IPC. `getSession` returns the preview partition session. */
const importSchema = z.object({
  browserId: z.string().min(1).max(32),
  cookies: z.boolean().optional(),
  extensions: z.array(z.string().max(64)).max(200).optional(),
});

export function registerBrowserDataIpc(
  getSession: () => Session,
  handleAppIpc: (channel: string, handler: (event: any, ...args: any[]) => any) => void,
  getMainWindow: () => BrowserWindow | null,
): void {
  const emit = (payload: Record<string, unknown>) => {
    try { getMainWindow()?.webContents.send("browser-data:event", payload); } catch {}
  };

  handleAppIpc("browser-data:detect", () => {
    try {
      return { ok: true, browsers: detectBrowsers() };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || "Detect failed", browsers: [] };
    }
  });

  handleAppIpc("browser-data:import", async (_e: unknown, raw: unknown) => {
    const parsed = importSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid import request" };
    const args = parsed.data;
    const summary = { imported: 0, skippedProtected: 0, failed: 0, blockedReason: "" as string };
    try {
      const browser = detectBrowsers().find((b) => b.id === args.browserId);
      if (!browser) return { ok: false, error: "Browser not found" };

      if (args.cookies !== false) {
        if (browser.kind === "firefox") {
          const dbPath = path.join(browser.profileDir, "cookies.sqlite");
          if (!fs.existsSync(dbPath)) {
            summary.blockedReason = "No cookies.sqlite found in that Firefox profile.";
          } else if (!sqliteAvailable()) {
            summary.blockedReason = "Cookie import needs the sqlite engine that this build does not include — use Import cookie file…";
          } else {
            emit({ type: "progress", stage: "reading-cookies" });
            const { cookies, failed } = await readFirefoxCookies(dbPath);
            const r = await importCookiesIntoSession(getSession(), cookies);
            summary.imported = r.imported;
            summary.failed = failed + r.failed;
          }
        } else {
          const cookiesPath = [
            path.join(browser.profileDir, "Network", "Cookies"),
            path.join(browser.profileDir, "Cookies"),
          ]
            .map((p) => (fs.existsSync(p) ? p : null))
            .find(Boolean);
          if (!cookiesPath) {
            summary.blockedReason = "No cookie database found in that profile.";
          } else if (!sqliteAvailable()) {
            summary.blockedReason = "Cookie import needs the sqlite engine that this build does not include — use Import cookie file…";
          } else {
            emit({ type: "progress", stage: "reading-cookies" });
            const state = readLocalState(browser.profileDir);
            const { cookies, protectedCount, failed } = await readChromiumCookies(cookiesPath, state);
            const r = await importCookiesIntoSession(getSession(), cookies);
            summary.imported = r.imported;
            summary.skippedProtected = protectedCount;
            summary.failed = failed + r.failed;
          }
        }
      }

      const extIds: string[] = args.extensions ?? [];
      let extensionsCopied = 0;
      let extensionsFailed = 0;
      if (extIds.length > 0) {
        emit({ type: "progress", stage: "copying-extensions" });
        const targetDir = path.join(app.getPath("userData"), "extensions");
        const wanted = browser.extensions.filter((e) => extIds.includes(e.id));
        const r = await copyExtensions(targetDir, wanted);
        extensionsCopied = r.copied;
        extensionsFailed = r.failed;
      }

      emit({ type: "done", ...summary, extensionsCopied, extensionsFailed });
      safeConsoleWrite(process.stdout, `[browser-data] imported cookies=${summary.imported} protected=${summary.skippedProtected} failed=${summary.failed} exts=${extensionsCopied}\n`);
      return { ok: true, ...summary, extensionsCopied, extensionsFailed };
    } catch (err) {
      emit({ type: "error", error: (err as Error)?.message || "Import failed" });
      return { ok: false, error: (err as Error)?.message || "Import failed", ...summary };
    }
  });

  handleAppIpc("browser-data:import-cookie-file", async () => {
    try {
      const pick = await pickCookieFile(getMainWindow);
      if (pick.length === 0) return { ok: true, cookies: [], cancelled: true };
      const text = fs.readFileSync(pick[0], "utf8");
      const cookies = pick[0].toLowerCase().endsWith(".json") ? parseCookieEditorJson(text) : parseNetscapeCookies(text);
      if (cookies.length === 0) return { ok: true, cookies: [], error: "No cookies found in that file (expected Netscape cookies.txt or Cookie-Editor JSON)." };
      const r = await importCookiesIntoSession(getSession(), cookies);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || "Cookie-file import failed" };
    }
  });
}
