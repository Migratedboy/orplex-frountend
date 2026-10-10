import crypto from "node:crypto";

export interface DesktopAuthCode {
  provider: string;
  createdAt: number;
  used: boolean;
  /**
   * sha256 of the initiator cookie (see mintDesktopCode). The browser that
   * arms the code must present the matching token — otherwise anyone who
   * learns a code (logs, history, shoulder-surfing) could arm it with THEIR
   * session and hand the attacker their identity (login CSRF).
   */
  flowHash?: string;
  /** Filled by the finish route once the user is authenticated. */
  session?: { id: string; name?: string | null; email?: string | null; image?: string | null };
}

const TTL_MS = 5 * 60_000;

/** Initiator-binding cookie name (minted at start, verified at finish). */
export const DESKTOP_FLOW_COOKIE = "orplex_desktop_flow";
// Single-instance deployment: in-memory store is fine. If the backend ever
// runs multiple instances, move this to Prisma/Redis keyed by the code.
const codes = new Map<string, DesktopAuthCode>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (now - v.createdAt > TTL_MS) codes.delete(k);
}

export function mintDesktopCode(provider: string): { code: string; flowToken: string } {
  prune();
  const code = crypto.randomUUID();
  const flowToken = crypto.randomBytes(32).toString("base64url");
  const flowHash = crypto.createHash("sha256").update(flowToken).digest("hex");
  codes.set(code, { provider, createdAt: Date.now(), used: false, flowHash });
  return { code, flowToken };
}

/**
 * Verify the arming browser is the minting browser (double-submit cookie
 * pattern): the token never leaves HttpOnly cookie storage, so a cross-site
 * attacker cannot present it. Timing-safe; false on any mismatch or when
 * the entry predates flow binding.
 */
export function checkDesktopFlow(code: string, flowToken: string | null | undefined): boolean {
  const entry = getDesktopCode(code);
  if (!entry || !entry.flowHash || !flowToken) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(crypto.createHash("sha256").update(flowToken).digest("hex"), "hex"),
      Buffer.from(entry.flowHash, "hex")
    );
  } catch {
    return false;
  }
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
