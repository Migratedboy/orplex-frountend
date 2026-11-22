// install-icon-pack.mjs — copy the supplied Orplex Code icon pack into every
// slot the app renders, BYTE FOR BYTE.
//
// Why verbatim: the pack is authored art. Deriving from it (trimming, cropping,
// keying the matte, re-fitting) produced icons that were not the design — a
// hard-black square window icon and mush at 16px in the tray. The pack already
// ships the right variants: build/icon.ico and .icns for packaging,
// build/icons/* for the exact pixel sizes, assets/tray/* for the notification
// AREA (colour 16px + 32px, plus the macOS template pair), and the rounded
// tile whose corners are genuinely transparent.
//
// Nothing here is redrawn, trimmed, recoloured or rescaled: every destination
// below is a byte-for-byte copy of a pack file.
//
// Usage: node scripts/install-icon-pack.mjs "C:/Users/<you>/Downloads/electron-icons (4).zip"
//        node scripts/install-icon-pack.mjs <extracted-pack-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/install-icon-pack.mjs "<pack.zip | pack-dir>"');
  process.exit(1);
}

/** Zip → temp dir (Expand-Archive is the only zip reader on this box). */
function unpack(zip) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-icons-"));
  const ps = [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest}' -Force`,
  ];
  execFileSync("powershell.exe", ps, { stdio: "pipe" });
  return dest;
}

const root = fs.existsSync(input) && fs.statSync(input).isDirectory() ? input : unpack(input);
const pack = fs.existsSync(path.join(root, "electron-icons")) ? path.join(root, "electron-icons") : root;

/** [source relative to the pack, destination relative to the repo] */
const SLOTS = [
  // --- Windows packaging (electron-builder win.icon, NSIS installer) --------
  ["build/icon.ico", "electron/assets/icon.ico"],
  ["build/icon.ico", "build/icon.ico"],
  // --- macOS / Linux packaging --------------------------------------------
  ["build/icon.icns", "electron/assets/icon.icns"],
  ["build/icon.png", "build/icon.png"],
  // --- BrowserWindow icon (taskbar / window / Alt-Tab) --------------------
  ["build/icon.png", "electron/assets/icon.png"],
  ["build/icons/32x32.png", "electron/assets/icon32.png"],
  // --- Notification area (the "^" popup). Lives OUTSIDE the asar. ----------
  ["build/icon.ico", "resources/tray.ico"],
  ["assets/tray/tray.png", "resources/tray.png"],
  ["assets/tray/tray@2x.png", "resources/tray@2x.png"],
  ["assets/tray/trayTemplate.png", "resources/trayTemplate.png"],
  ["assets/tray/trayTemplate@2x.png", "resources/trayTemplate@2x.png"],
  // --- Window icon the dev shell loads from the compiled tree --------------
  ["build/icons/32x32.png", "electron/assets/tray.png"],
  // --- Web/favicon slots (NOT the in-app mascot: that is orplex-mascot.svg /
  //     logo.svg and is intentionally left alone) ---------------------------
  ["build/icons/256x256.png", "public/logo.png"],
  ["build/icons/256x256.png", "src/app/icon.png"],
];

for (const [from, to] of SLOTS) {
  const src = path.join(pack, from);
  if (!fs.existsSync(src)) {
    console.error(`missing in pack: ${from}`);
    process.exit(1);
  }
  const dest = path.join(ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  ${to.padEnd(30)} <- ${from} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
}

// Compiled copies of the OLD artwork are the reason a rebrand never reached the
// taskbar: `electron-dist/assets/icon.ico` was probed before the real file.
// Nothing reads icons from the compiled tree any more, so delete them.
const residue = path.join(ROOT, "electron-dist", "assets");
if (fs.existsSync(residue)) {
  for (const name of fs.readdirSync(residue)) {
    if (!/\.(ico|png|icns)$/i.test(name)) continue;
    fs.rmSync(path.join(residue, name), { force: true });
    console.log(`  removed stale electron-dist/assets/${name}`);
  }
}

// The wordmark slot is an <img src="/orplex-logo.svg"> target. The pack ships no
// SVG, so wrap the 256px tile as a data URI rather than inventing vector art.
const png = fs.readFileSync(path.join(ROOT, "public", "logo.png")).toString("base64");
fs.writeFileSync(
  path.join(ROOT, "public", "orplex-logo.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Orplex">
  <!-- Orplex Code mark, from the shipped icon pack (build/icons/256x256.png).
       The pack is raster-only, so this wrapper keeps every <img src="/orplex-logo.svg">
       slot working. Regenerate with scripts/install-icon-pack.mjs. -->
  <image href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}" x="0" y="0" width="256" height="256" preserveAspectRatio="xMidYMid meet"/>
</svg>
`,
);
console.log(`  public/orplex-logo.svg          <- wrapped 256px tile`);
console.log("done. Bump nothing else: the dev launcher derives a new exe name from the icon hash.");
