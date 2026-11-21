// The sign-in handoff URL is easy to get subtly wrong, and a wrong value fails
// silently: the user authorises on the mediator site, is sent back to a page
// that never redeems the grant, and lands on /auth/signin?callbackUrl=%2F with no
// session. (That was a real bug — the buttons returned to the caller's path.)
//
// The URL builder is pure, so these tests need no browser navigation stubs.

import { mediatorSignInUrl, safeNextPath, siteOrigin, signInCallbackPath } from "@/lib/signin-mediator";

const APP = "http://127.0.0.1:5000";
const SITE = "https://site.test";

describe("mediatorSignInUrl", () => {
  it("returns to the grant-redeeming page, never to the caller's own path", () => {
    const url = new URL(mediatorSignInUrl("github", APP, "/", SITE));
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/api/auth/desktop/start");
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("return_to")).toBe(`${APP}/auth/signin`);
  });

  it("carries the caller's destination as ?next= so Settings can come back to itself", () => {
    const returnTo = new URL(mediatorSignInUrl("github", APP, "/settings?tab=account", SITE)).searchParams.get(
      "return_to"
    )!;
    expect(returnTo.startsWith(`${APP}/auth/signin?next=`)).toBe(true);
    expect(decodeURIComponent(returnTo)).toContain("/settings?tab=account");
  });

  it("keeps the provider in the query so Google sign-in works the same way", () => {
    expect(new URL(mediatorSignInUrl("google", APP, "/", SITE)).searchParams.get("provider")).toBe("google");
  });

  it("encodes the return target exactly once", () => {
    const raw = mediatorSignInUrl("github", APP, "/", SITE);
    // A double-encoded target would send the browser to /auth%2Fsignin.
    expect(raw).toContain("return_to=http%3A%2F%2F127.0.0.1%3A5000%2Fauth%2Fsignin");
    expect(raw).not.toContain("%253A");
  });
});

describe("siteOrigin / signInCallbackPath", () => {
  it("exposes the configured site without a trailing slash", () => {
    expect(siteOrigin()).toMatch(/^https?:\/\/[^/]+$/);
    expect(signInCallbackPath()).toBe("/auth/signin");
  });
});

describe("safeNextPath", () => {
  it("accepts same-origin paths", () => {
    expect(safeNextPath("?next=%2Fsettings")).toBe("/settings");
    expect(safeNextPath("?next=%2F")).toBe("/");
  });

  it("refuses protocol-relative, absolute and backslash URLs", () => {
    expect(safeNextPath("?next=%2F%2Fevil.example")).toBe("/");
    expect(safeNextPath("?next=https%3A%2F%2Fevil.example")).toBe("/");
    expect(safeNextPath("?next=%5C%5Cevil.example")).toBe("/");
  });

  it("falls back when the parameter is missing", () => {
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("?other=1", "/projects")).toBe("/projects");
  });
});
