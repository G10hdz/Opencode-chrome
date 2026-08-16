#!/usr/bin/env node
// Generates extension/icons/*.png with zero dependencies (hand-rolled PNG encoder).
// Design: dark rounded square, green terminal chevron ">" and cursor.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.18; // corner radius
  const bg = [24, 26, 31]; // near-black
  const fg = [76, 175, 80]; // green
  const t = Math.max(1.5, size * 0.09); // stroke thickness

  const distToSeg = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
    const ex = x1 + u * dx - x, ey = y1 + u * dy - y;
    return Math.hypot(ex, ey);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square coverage (anti-aliased corner)
      const cx = Math.min(Math.max(x, r), size - 1 - r);
      const cy = Math.min(Math.max(y, r), size - 1 - r);
      const d = Math.hypot(x - cx, y - cy);
      const inside = Math.min(Math.max(r - d + 0.5, 0), 1);
      if (inside <= 0) continue;
      let c = bg;
      // chevron ">": from left-mid-upper to right-mid to left-mid-lower
      const u = size * 0.30, m = size * 0.52;
      const top = [u, size * 0.30], mid = [m, size * 0.5], bot = [u, size * 0.70];
      if (
        distToSeg(x, y, top[0], top[1], mid[0], mid[1]) < t / 2 ||
        distToSeg(x, y, mid[0], mid[1], bot[0], bot[1]) < t / 2
      ) c = fg;
      // cursor underscore
      if (x >= size * 0.62 && x <= size * 0.78 && y >= size * 0.66 && y <= size * 0.66 + t) c = fg;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = Math.round(inside * 255);
    }
  }
  return png(size, px);
}

mkdirSync(new URL("../extension/icons/", import.meta.url), { recursive: true });
for (const s of [16, 48, 128]) {
  writeFileSync(new URL(`../extension/icons/icon${s}.png`, import.meta.url), icon(s));
  console.log(`icon${s}.png`);
}
