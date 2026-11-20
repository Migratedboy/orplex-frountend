// dev-branded-electron.mjs — run the app from a BRANDED electron binary.
//
// Why: on Windows the taskbar button draws the ICON OF THE RUNNING EXE.
// In development that exe is node_modules/electron/dist/electron.exe, so the
// taskbar shows the Electron logo no matter what BrowserWindow.icon says.
// (A packaged build has its own branded exe — electron-builder injects the
// icon there — so only the dev path needs this.)
//
// What: copy electron.exe into .orplex/, inject electron/assets/icon.ico
// into its PE resources (resedit — the same library electron-builder uses),
// then launch that copy with the app path. The copy is rebuilt only when
// the icon changes, so dev startup stays fast.
//
// Non-Windows: no branding needed — just run electron like before.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconPath = path.join(root, "electron", "assets", "icon.ico");

function runElectron(args) {
  const electronBin = require("electron"); // path to electron's cli.js
  const child = spawn(process.execPath, [electronBin, ...args], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.platform !== "win32") {
  runElectron(process.argv.slice(2).length ? process.argv.slice(2) : ["."]);
} else {
  const electronDist = path.dirname(require("electron"));
  const srcExe = path.join(electronDist, "electron.exe");
  // The branded copy MUST live next to electron.exe: Electron loads its ICU
  // data and .pak files relative to the executable, so a copy elsewhere
  // dies with "Invalid file descriptor to ICU data received".
  // The copy is named after a hash of the icon, not just "orplex-dev.exe".
  // Windows caches a taskbar button's icon per executable PATH (and per AUMID),
  // so rewriting the same path with a new icon left the old logo on screen even
  // though the exe resources were new. A new icon now means a new path, which
  // has no cache entry at all. icon-poison.ts matches the "orplex-dev*" prefix.
  const iconHash = crypto.createHash("sha256").update(fs.readFileSync(iconPath)).digest("hex").slice(0, 8);
  const outExe = path.join(electronDist, `orplex-dev-${iconHash}.exe`);
  const stampFile = path.join(electronDist, `orplex-dev-${iconHash}.stamp`);

  const stat = (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  };

  const src = stat(srcExe);
  const icon = stat(iconPath);
  if (!src || !icon) {
    console.warn("[dev-icon] electron.exe or icon.ico missing — running the stock binary.");
    runElectron(process.argv.slice(2).length ? process.argv.slice(2) : ["."]);
  } else {
    const stamp = `${src.size}:${src.mtimeMs}:${icon.size}:${icon.mtimeMs}`;
    const current = (() => {
      try {
        return fs.readFileSync(stampFile, "utf8").trim();
      } catch {
        return "";
      }
    })();

    if (current !== stamp || !stat(outExe)) {
      fs.mkdirSync(electronDist, { recursive: true });
      const buffer = fs.readFileSync(srcExe);
      const { NtExecutable, NtExecutableResource, Data, Resource } = require("resedit");
      const executable = NtExecutable.from(buffer);
      const res = NtExecutableResource.from(executable);

      // Product identity: without this Windows calls the app "Electron"
      // (firewall prompts, taskbar tooltips, process list).
      const versionInfoList = Resource.VersionInfo.fromEntries(res.entries);
      const vi = versionInfoList.length > 0 ? versionInfoList[0] : Resource.VersionInfo.createEmpty();
      const languages = vi.getAllLanguagesForStringValues();
      const lang = languages.length > 0 ? languages[0] : { lang: 0x0409, codepage: 1200 };
      vi.setStringValues(lang, {
        CompanyName: "orplex.techlimited",
        ProductName: "Orplex Code",
        FileDescription: "Orplex Code",
        InternalName: "Orplex Code",
        OriginalFilename: "Orplex Code.exe",
        LegalCopyright: "Copyright © 2026 orplex.techlimited",
      });
      vi.outputToResourceEntries(res.entries);

      const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
      // Icon group id 1 / en-US — the same slot electron-builder writes.
      Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,
        0x0409,
        iconFile.icons.map((i) => i.data),
      );
      res.outputResource(executable);
      fs.writeFileSync(outExe, Buffer.from(executable.generate()));
      fs.writeFileSync(stampFile, stamp);
      // Drop copies made for a previous logo: a stale orplex-dev-*.exe is dead
      // weight and, if anything launched it, would show the old taskbar logo.
      for (const entry of fs.readdirSync(electronDist)) {
        const stale = /^orplex-dev(-[0-9a-f]{8})?\.(exe|stamp)$/i.test(entry);
        const mine = entry.startsWith(path.basename(outExe)) || entry === path.basename(stampFile);
        if (stale && !mine) {
          try {
            fs.rmSync(path.join(electronDist, entry), { force: true });
          } catch {}
        }
      }
      console.log(`[dev-icon] branded ${path.basename(outExe)} written with the Orplex icon.`);
    }

    const child = spawn(outExe, process.argv.slice(2).length ? process.argv.slice(2) : ["."], {
      stdio: "inherit",
      cwd: root,
      // A renamed electron binary looks "packaged" to Electron — this flag
      // tells the app it is really a checkout (see electron/dev-mode.ts).
      env: { ...process.env, ORPLEX_DEV: "1" },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}
