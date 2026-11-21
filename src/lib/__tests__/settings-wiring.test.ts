// Guard: settings controls must be wired to something.
//
// The old settings screen had a "Report issue" button that dispatched
// `orplex:bug-report` to nobody, and the newer screen shipped switches that
// wrote localStorage keys no code read. Both are indistinguishable from a
// working control until you click them, so this test reads the source and
// checks the wiring statically.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const PAGE = path.join(ROOT, "src/components/settings/settings-page.tsx");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const pageSource = fs.readFileSync(PAGE, "utf8");
const allSources = walk(path.join(ROOT, "src"))
  .filter((f) => !f.endsWith("settings-page.tsx"))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");

describe("settings page is wired", () => {
  it("every custom event it dispatches has a listener elsewhere", () => {
    const dispatched = [...pageSource.matchAll(/dispatchEvent\(\s*new CustomEvent\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(dispatched.length).toBeGreaterThan(0);
    // Listeners may live in any module, including this page itself (it listens
    // for its own tab-switch event from the command palette).
    const everySource = pageSource + "\n" + allSources;
    const unlistened = dispatched.filter((name) => !everySource.includes(`addEventListener("${name}"`));
    expect(unlistened).toEqual([]);
  });

  it("has no button that does nothing when clicked", () => {
    // Empty handler, or a handler that only returns.
    expect(pageSource).not.toMatch(/onClick=\{\(\)\s*=>\s*\{\s*\}\}/);
    expect(pageSource).not.toMatch(/onClick=\{\(\)\s*=>\s*undefined\}/);
    expect(pageSource).not.toMatch(/href="#"/);
    expect(pageSource).not.toMatch(/Coming soon/i);
    expect(pageSource).not.toMatch(/not implemented/i);
  });

  it("every toggle it renders is backed by a key some other module reads", () => {
    // Keys the page writes through writeAppSettings() or localStorage.
    const keys = [
      ...pageSource.matchAll(/writeAppSettings\(\{\s*(\w+)/g),
      ...pageSource.matchAll(/localStorage\.setItem\("([^"]+)"/g),
    ].map((m) => m[1]);
    const consumers = walk(path.join(ROOT, "src"))
      .filter((f) => !f.endsWith("settings-page.tsx"))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const key of new Set(keys)) {
      const read = consumers.includes(`.${key}`) || consumers.includes(`"${key}"`);
      expect([key, read]).toEqual([key, true]);
    }
  });

  it("routes unknown/legacy tab ids to a page that exists instead of a blank screen", () => {
    const pages = [...pageSource.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:/g)].map((m) => m[1]);
    expect(pages).toContain("permissions");
    expect(pages).toContain("general");
    // Legacy ids referenced by the mapper must resolve to a real key.
    const legacyBlock = pageSource.slice(pageSource.indexOf("const LEGACY"), pageSource.indexOf("function pageKeyFromUrl"));
    const targets = [...legacyBlock.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const target of targets) {
      expect(pages).toContain(target);
    }
  });
});
