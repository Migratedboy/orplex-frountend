import crypto from "node:crypto";

export interface DesktopAuthCode {
  provider: string;
  createdAt: number;
  used: boolean;
  /** Filled by the finish route once the user is authenticated. */
  session?: { id: string; name?: string | null; email?: string | null; image?: string | null };
}

const TTL_MS = 10 * 60_000;
// Single-instance deployment: in-memory store is fine. If the backend ever
// runs multiple instances, move this to Prisma/Redis keyed by the code.
const codes = new Map<string, DesktopAuthCode>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (now - v.createdAt > TTL_MS) codes.delete(k);
}

export function mintDesktopCode(provider: string): string {
  prune();
  const code = crypto.randomUUID();
  codes.set(code, { provider, createdAt: Date.now(), used: false });
  return code;
}

export function getDesktopCode(code: string): DesktopAuthCode | null {
  prune();
  return codes.get(code) ?? null;
}

export function armDesktopCode(code: string, session: DesktopAuthCode["session"]): boolean {
  const entry = getDesktopCode(code);
  if (!entry || entry.used) return false;
  entry.session = session;
  return true;
}

/** Validate + burn atomically; returns null for unknown/expired/reused/unarmed codes. */
export function consumeDesktopCode(code: string): DesktopAuthCode | null {
  const entry = getDesktopCode(code);
  if (!entry || entry.used || !entry.session) return null;
  entry.used = true;
  codes.delete(code);
  return entry;
}
