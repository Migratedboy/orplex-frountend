/**
 * Tiny JSON persistence layer (settings + active lock session) using atomic
 * tmp-file + rename writes. Deliberately dependency-free.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SessionRecord {
  endAt: number;
  startedAt: number;
  strictMode: boolean;
  mode: 'lockdown' | 'class';
  /** Class mode: pinned window hwnd (decimal string), or null. */
  pinHwnd: string | null;
}

export interface WidgetPos {
  x: number | null;
  y: number | null;
}

interface PersistShape {
  session: SessionRecord | null;
  widget: WidgetPos;
}

function sanitizeSession(raw: unknown): SessionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const endAt = r['endAt'];
  const startedAt = r['startedAt'];
  const strictMode = r['strictMode'];
  const mode = r['mode'];
  const pinHwnd = r['pinHwnd'];
  if (typeof endAt !== 'number' || typeof startedAt !== 'number' || typeof strictMode !== 'boolean') {
    return null;
  }
  if (mode !== 'lockdown' && mode !== 'class') return null;
  if (pinHwnd !== null && typeof pinHwnd !== 'string') return null;
  if (!Number.isFinite(endAt) || !Number.isFinite(startedAt)) return null;
  if (startedAt <= 0 || endAt <= startedAt) return null;
  return { endAt, startedAt, strictMode, mode, pinHwnd: pinHwnd ?? null };
}

function sanitizeWidget(raw: unknown): WidgetPos {
  if (typeof raw !== 'object' || raw === null) return { x: null, y: null };
  const r = raw as Record<string, unknown>;
  const x = r['x'];
  const y = r['y'];
  const toCoord = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
  return { x: toCoord(x), y: toCoord(y) };
}

export class Store {
  private readonly file: string;
  private data: PersistShape;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'focuslock-state.json');
    this.data = { session: null, widget: { x: null, y: null } };
    this.load();
  }

  getSession(): SessionRecord | null {
    return this.data.session;
  }

  setSession(session: SessionRecord): void {
    this.data.session = session;
    this.save();
  }

  clearSession(): void {
    this.data.session = null;
    this.save();
  }

  getWidgetPos(): WidgetPos {
    return { ...this.data.widget };
  }

  setWidgetPos(x: number, y: number): void {
    this.data.widget = { x: Math.round(x), y: Math.round(y) };
    this.save();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const rec = parsed as Record<string, unknown>;
      this.data = {
        session: sanitizeSession(rec['session']),
        widget: sanitizeWidget(rec['widget']),
      };
    } catch {
      // First run or unreadable file: start with defaults.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed:', err);
    }
  }
}
