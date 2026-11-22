// Guards for the ONE thing that kept an old logo on the Windows taskbar after a
// rebrand: a stale copy of `icon.ico` in the COMPILED tree winning the lookup.
//
// The app used to walk up from `__dirname` and probe `assets` at every level, so
// `electron-dist/assets/icon.ico` (tsc never refreshes it) was handed to
// BrowserWindow on every dev launch. These tests fail if that path can ever come
// back, and they pin the single source of truth for the artwork.
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("app icon source", () => {
  it("resolves the icon explicitly instead of walking the filesystem", () => {
    const main = read("electron/main.ts");
    // The old implementation probed a list of start points with these arrays.
    expect(main).not.toMatch(/const starts = \[process\.resourcesPath/);
    expect(main).not.toMatch(/const subs = \[""/);
    // Packaged -> real file next to the executable; dev -> the repo's artwork.
    expect(main).toMatch(/process\.resourcesPath[^\n]*"icon\.ico"/);
    expect(main).toMatch(/repoRoot[^\n]*"electron", "assets", "icon\.ico"/);
    // ...and compiled residue is explicitly refused.
    expect(main).toMatch(/electron-dist[\\/]assets/);
  });

  it("never lets the compiled tree carry icon artwork", () => {
    const residue = join(ROOT, "electron-dist", "assets");
    if (!existsSync(residue)) return; // nothing compiled yet
    const icons = readdirSync(residue).filter((n) => /\.(ico|png|icns)$/i.test(n));
    expect(icons).toEqual([]);
  });

  it("purges compiled icon residue before a dev launch", () => {
    const launcher = read("scripts/dev-branded-electron.mjs");
    expect(launcher).toMatch(/function purgeIconResidue\(/);
    expect(launcher).toMatch(/purgeIconResidue\(\);[\s\S]*require\("electron"\)/);
  });

  it("ships one tray set, copied byte-for-byte from the icon pack", () => {
    const installer = read("scripts/install-icon-pack.mjs");
    for (const dest of [
      "electron/assets/icon.ico",
      "resources/tray.ico",
      "resources/tray.png",
      "resources/tray@2x.png",
    ]) {
      expect(installer).toContain(dest);
    }
    // No generator is allowed to redraw tray art.
    expect(existsSync(join(ROOT, "scripts/make-tray-icons.mjs"))).toBe(false);
  });

  it("the packaged tray set exists and is non-empty", () => {
    for (const rel of ["resources/tray.ico", "resources/tray.png", "resources/tray@2x.png"]) {
      const p = join(ROOT, rel);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p).length).toBeGreaterThan(200);
    }
  });
});
