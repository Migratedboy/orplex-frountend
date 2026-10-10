// build-icons.mjs — Regenerate derived app icons from electron/assets/icon.png.
// Produces icon.icns (macOS: 128/256/512 PNG-compressed elements) for
// electron-builder's mac.icon. The .ico (Windows) is checked in and valid;
// rerun this after any logo change:  node scripts/build-icons.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "electron", "assets", "icon.png");
const OUT = join(ROOT, "electron", "assets", "icon.icns");

if (!existsSync(SRC)) {
  console.error(`missing source: ${SRC}`);
  process.exit(1);
}

const { default: sharp } = await import("sharp");

// icns element types for PNG payloads (modern macOS accepts PNG-compressed).
const SIZES = [
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
];

const elements = [];
for (const { type, size } of SIZES) {
  const png = await sharp(readFileSync(SRC)).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(8 + png.length, 4);
  elements.push(header, png);
}

const body = Buffer.concat(elements);
const fileHeader = Buffer.alloc(8);
fileHeader.write("icns", 0, "ascii");
fileHeader.writeUInt32BE(8 + body.length, 4);
writeFileSync(OUT, Buffer.concat([fileHeader, body]));
console.log(`wrote ${OUT} (${SIZES.map((s) => s.size).join("/")}px, ${(8 + body.length / 1024).toFixed(0)}KB total header+KB)`);
