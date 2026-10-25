// Generates the outer-shell Orplex icons from the mascot artwork.
// Default source: public/logo.svg (bare creature, transparent) — the tile
// variant assets/orplex-icon-v2.png is still supported and additionally gets
// the amplified glow ring for shell legibility. SVG is rasterized at high
// density so the 512px render stays crisp.
//   electron/assets/icon.png    — Electron window/taskbar PNG (non-win fallback)
//   electron/assets/icon.ico    — Windows window/taskbar (16/32/48/256, PNG-in-ICO)
//   electron/assets/icon32.png  — tray icon
//   electron/assets/tray.png    — tray fallback
//   public/logo.png             — favicon route source + OS notification icon
//   src/app/icon.png            — Next app icon (browser tab)
//   electron-dist/assets/*      — mirror of the electron assets (what the
//                                 packaged/dev shell actually loads; tsc does
//                                 NOT copy assets, so this script mirrors them)
//
// The in-app animated mascot is untouched — this only refreshes the OUTER
// shell surfaces. Run: node scripts/make-icons.mjs [source-svg-or-png] [flags]
//   --no-ring      skip the amplified orange glow ring (art that is already a
//                  finished tile design — glow would shadow it)
//   --shell-only   write only electron/assets + mirrors (never public/ or
//                  src/app icons — the in-app/web surfaces stay on the mascot)
// The ICO is a hand-rolled PNG-in-ICO container (Vista+), so sharp alone
// suffices — no icon-editor dependency.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ?? join(root, "public", "logo.svg");
assert.ok(existsSync(src), `source icon not found: ${src}`);
const isVector = /\.svg$/i.test(src);
const flags = new Set(process.argv.slice(3));
const noRing = flags.has("--no-ring");
const shellOnly = flags.has("--shell-only");

const sizes = {
  iconPng: 512,
  tray: 32,
  favicon: 256,
  ico: [16, 24, 32, 48, 64, 128, 256],
};

// For SVG sources, rasterize at high density (72dpi default would render the
// 320-unit viewBox at 320px and blur when scaled to 512).
const rootPng = await sharp(src, isVector ? { density: Math.ceil(72 * (sizes.iconPng / 320)) } : {}).png().toBuffer();

async function pngOf(size) {
  return sharp(rootPng).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

// The source art's warm rim + outer glow span ~2% of the canvas; at shell
// sizes (16–48px) that downsamples below one pixel and disappears, leaving a
// flat black square. Bake an amplified glow ring into every generated size so
// the rim survives — the source PNG itself stays untouched.
function ringSvg(size, widthFrac, color, opacity) {
  const inset = Math.max(0.5, size * 0.012);
  const sw = Math.max(0.75, size * widthFrac);
  const r = Math.round(size * 0.13);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${r}" ` +
    `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${sw}"/></svg>`
  );
}

async function withGlowBorder(size) {
  const base = await pngOf(size);
  const glow = await sharp(ringSvg(size, 0.05, "#FB923C", 0.5)).blur(Math.max(1, size * 0.022)).png().toBuffer();
  const ring = await sharp(ringSvg(size, 0.02, "#F97316", 0.9)).png().toBuffer();
  return sharp(base).composite([{ input: glow }, { input: ring }]).png().toBuffer();
}

// ICO: PNG-in-ICO entries (Vista+ shell + Chromium both decode these; the
// probe in .localpg/test-icon.js verifies non-empty decode). Note: classic
// BMP entries were tried and Chromium's ICO decoder rejected them here, so
// PNG stays for every size.
function buildIco(entries) {
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(e.size === 256 ? 0 : e.size, o); // width (0 = 256)
    header.writeUInt8(e.size === 256 ? 0 : e.size, o + 1); // height
    header.writeUInt8(0, o + 2); // palette
    header.writeUInt8(0, o + 3); // reserved
    header.writeUInt16LE(1, o + 4); // color planes
    header.writeUInt16LE(32, o + 6); // bits per pixel
    header.writeUInt32LE(e.bytes.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += e.bytes.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.bytes)]);
}

// The amplified glow ring only makes sense on the dark-tile art; the bare
// mascot renders as-is, and so does any --no-ring source (finished artwork).
const makeIcon = (size) => (isVector || noRing ? pngOf(size) : withGlowBorder(size));
const [icon512, tray32, fav256] = await Promise.all([sizes.iconPng, sizes.tray, sizes.favicon].map((s) => makeIcon(s)));
const icoEntries = (await Promise.all(sizes.ico.map((s) => makeIcon(s).then((bytes) => ({ size: s, bytes }))))).sort((a, b) => a.size - b.size);
const icoBuf = buildIco(icoEntries);

// ICNS (mac): PNG-compressed entries are valid since macOS 10.13. Only the
// large dock/app surfaces need cover — Electron takes the .icns from
// electron-builder, and `type` encodes the logical pixel size.
function buildIcns(entries) {
  const body = Buffer.concat(entries.map((e) => {
    const sub = Buffer.alloc(8);
    sub.write(e.type, 0, "ascii");
    sub.writeUInt32BE(e.bytes.length + 8, 4);
    return Buffer.concat([sub, e.bytes]);
  }));
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const asIcnsEntry = (type, size) => makeIcon(size).then((bytes) => ({ type, bytes }));
const icnsBuf = buildIcns(
  await Promise.all([
    asIcnsEntry("ic07", 128),
    asIcnsEntry("ic08", 256),
    asIcnsEntry("ic09", 512),
    asIcnsEntry("ic10", 1024),
  ])
);

const targets = [
  [join(root, "electron/assets/icon.png"), icon512],
  [join(root, "electron/assets/icon.ico"), icoBuf],
  [join(root, "electron/assets/icon32.png"), tray32],
  [join(root, "electron/assets/tray.png"), tray32],
  [join(root, "electron/assets/icon.icns"), icnsBuf],
  [join(root, "public/logo.png"), fav256],
  [join(root, "src/app/icon.png"), fav256],
  // Mirror into the compiled output the Electron shell loads from.
  [join(root, "electron-dist/assets/icon.png"), icon512],
  [join(root, "electron-dist/assets/icon.ico"), icoBuf],
  [join(root, "electron-dist/assets/icon32.png"), tray32],
  [join(root, "electron-dist/assets/tray.png"), tray32],
];

const shellTargets = targets.filter(([file]) => !file.includes("public") && !file.includes(join("src", "app")));

for (const [file, data] of (shellOnly ? shellTargets : targets)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${file} (${data.length} bytes)`);
}
console.log("outer-shell icons regenerated from", src, shellOnly ? "(shell only)" : "");
