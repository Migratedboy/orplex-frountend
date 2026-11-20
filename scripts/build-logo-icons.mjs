// build-logo-icons.mjs — regenerate every Orplex Code logo slot from ONE master.
//
// Why this exists: the first pass dropped the provided icon set in verbatim, and
// the "square-fullbleed" 256 art only fills 72% of the canvas width and 48% of
// its height — so the taskbar/favicon showed the mark surrounded by empty black.
// The mark is wide (≈1.5:1), so the fix is not a bigger crop, it is a consistent
// rule: trim to the artwork, then fit it to 88% of the square.
//
// Outputs (all from electron/assets/logo-master.png):
//   electron/assets/icon.png     1024  window/BrowserWindow + Linux target
//   electron/assets/icon.ico     16,24,32,48,64 (BMP) + 128,256 (PNG)
//   electron/assets/icon32.png   32    tray (tray.ts probes this first)
//   electron/assets/tray.png     32    tray fallback
//   public/logo.png              256   /favicon.ico route
//   src/app/icon.png             256   App Router tab icon
//   public/orplex-logo.svg       SVG wrapper around the 256 (updater wordmark)
// then: node scripts/build-icons.mjs  (derives icon.icns from icon.png)
//
// Usage: node scripts/build-logo-icons.mjs [source.png]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = path.join(ROOT, "electron", "assets", "logo-master.png");
const SRC = process.argv[2] || MASTER;
const FILL = 0.92; // share of the tile the artwork occupies, per axis
const FILL_TRAY = 0.98; // the tray renders at 16px — give it every pixel it can get
const BG = { r: 0, g: 0, b: 0, alpha: 1 }; // the mark ships on black

if (!fs.existsSync(SRC)) {
  console.error(`missing source image: ${SRC}`);
  process.exit(1);
}

/** Bounding box of "lit" pixels (ignores transparent + near-black padding). */
async function contentBox(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      if (data[i + 3] > 8 && data[i] + data[i + 1] + data[i + 2] > 60) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("source has no visible artwork");
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const box = await contentBox(SRC);
const trimmed = await sharp(SRC).extract(box).png().toBuffer();

/** Square tile: artwork centred, occupying `fill` of the side. */
async function tile(size, fill = FILL) {
  const inner = Math.max(1, Math.round(size * fill));
  const fitted = await sharp(trimmed)
    .resize(inner, inner, { fit: "contain", background: { ...BG, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: fitted, gravity: "center" }])
    .png()
    .toBuffer();
}

/** One .ico frame: PNG for the large sizes, BMP (DIB + AND mask) for the small. */
function bmpFrame(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // DIB rows are bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // all zero = "use alpha"
  return Buffer.concat([header, xor, mask]);
}

const ICO_SIZES = [
  { size: 16, png: false },
  { size: 24, png: false },
  { size: 32, png: false },
  { size: 48, png: false },
  { size: 64, png: false },
  { size: 128, png: true },
  { size: 256, png: true },
];

async function buildIco() {
  const frames = [];
  for (const { size, png } of ICO_SIZES) {
    if (png) {
      frames.push({ size, data: await tile(size) });
    } else {
      const raw = await sharp(await tile(size)).ensureAlpha().raw().toBuffer();
      frames.push({ size, data: bmpFrame(raw, size) });
    }
  }
  const dir = Buffer.alloc(6 + frames.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(frames.length, 4);
  let offset = dir.length;
  frames.forEach((f, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e);
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1);
    dir.writeUInt8(0, e + 2); // palette size
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bit count
    dir.writeUInt32LE(f.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += f.data.length;
  });
  return Buffer.concat([dir, ...frames.map((f) => f.data)]);
}

function write(rel, buf) {
  const target = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  console.log(`  ${rel.padEnd(30)} ${(buf.length / 1024).toFixed(1)} KB`);
}

console.log(`logo: ${path.relative(ROOT, SRC)} → trimmed ${box.width}x${box.height}, fill ${FILL * 100}%`);

const master1024 = await tile(1024);
write("electron/assets/logo-master.png", master1024);
write("electron/assets/icon.png", master1024);
write("electron/assets/icon.ico", await buildIco());
// The notification area draws this at 16 logical px, so it gets a tighter crop
// than the window icon: at 16px the 8% inner margin turned the ribbons into mush.
write("electron/assets/icon32.png", await tile(32, FILL_TRAY));
write("electron/assets/tray.png", await tile(32, FILL_TRAY));

const logo256 = await tile(256);
write("public/logo.png", logo256);
write("src/app/icon.png", logo256);

const b64 = logo256.toString("base64");
write(
  "public/orplex-logo.svg",
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Orplex">
  <!-- Orplex Code mark. The icon set ships raster only, so this SVG wraps the
       256px render as a data URI: every <img src="/orplex-logo.svg"> slot keeps
       working. Regenerate with scripts/build-logo-icons.mjs. -->
  <image href="data:image/png;base64,${b64}" xlink:href="data:image/png;base64,${b64}" x="0" y="0" width="256" height="256" preserveAspectRatio="xMidYMid meet"/>
</svg>
`),
);

console.log("done — now run: node scripts/build-icons.mjs");
