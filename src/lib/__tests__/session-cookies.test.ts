/** @jest-environment node */
export {};

import { NextResponse } from "next/server";
import { clearAllSessionCookies, clearedSessionResponse, ALL_SESSION_COOKIE_NAMES } from "@/lib/session-cookies";
import { APP_SESSION_COOKIE } from "@/lib/app-session";

function cookieValue(headers: Headers, name: string): string | null {
  // getSetCookie preserves each Set-Cookie line (undici/Next). Fall back to get.
  const lines: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  const hit = lines.find((l) => l.startsWith(`${name}=`));
  if (!hit) return null;
  return hit.split(";")[0].slice(name.length + 1);
}

function cookieLines(headers: Headers, name: string): string[] {
  const lines: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  return lines.filter((l) => l.startsWith(`${name}=`));
}

describe("session cookie clearing (A→B account switch fix)", () => {
  it("names every credential the app can mint, including the desktop extras", () => {
    expect(ALL_SESSION_COOKIE_NAMES).toEqual([
      "next-auth.session-token",
      "__Secure-next-auth.session-token",
      APP_SESSION_COOKIE,
    ]);
    expect(APP_SESSION_COOKIE).toBe("orplex-app-session");
  });

  it("expires __Secure-next-auth.session-token with secure:true (prefix requires it)", () => {
    const res = NextResponse.json({ ok: true });
    clearAllSessionCookies(res);
    const lines = cookieLines(res.headers, "__Secure-next-auth.session-token");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/Max-Age=0/i);
    expect(lines.join("\n")).toMatch(/Secure/i);
  });

  it("expires the unprefixed token and the app session (cleared for secure+non-secure variants)", () => {
    const res = NextResponse.json({ ok: true });
    clearAllSessionCookies(res);
    for (const name of ["next-auth.session-token", "orplex-app-session"]) {
      const lines = cookieLines(res.headers, name);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toMatch(/Max-Age=0/i);
    }
  });

  it("clearedSessionResponse returns JSON body and sets the clears", async () => {
    const res = clearedSessionResponse({ ok: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(cookieLines(res.headers, "orplex-app-session").length).toBeGreaterThan(0);
  });
});
