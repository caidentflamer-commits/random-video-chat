// Generates the app icons as PNGs with no image libraries — pure Node (zlib is
// built in, and a PNG is just zlib-compressed scanlines with CRCs). The mark is
// drawn with math: the brand's purple square, carrying a white ring — the O of
// Olumie. Deterministic: same script, same bytes. Re-run after design changes:
//   node tools/make_icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');
const PURPLE = [0x6d, 0x63, 0xff];   // --primary in the stage theme
const WHITE = [0xff, 0xff, 0xff];

// ---- minimal PNG writer ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8-bit, RGBA
  // one filter byte (0 = none) per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`  ${path.basename(file)}  ${size}x${size}  ${png.length} bytes`);
}

// ---- the mark --------------------------------------------------------------
// Coverage helpers: signed distance in pixels, feathered over 1px for clean
// anti-aliased edges at every size.
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d));
// Rounded-square signed distance (negative inside).
function sdRoundBox(x, y, half, r) {
  const qx = Math.abs(x) - (half - r), qy = Math.abs(y) - (half - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
// opts.fullBleed: opaque to the edges — for the maskable icon (the platform
// applies its own mask) and the apple-touch icon (iOS rounds corners itself).
function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const cornerR = size * 0.2135;                       // matches the app's tile radius feel
  const ringR = size * (opts.fullBleed ? 0.26 : 0.30); // maskable safe zone is the middle 80%
  const ringT = size * (opts.fullBleed ? 0.050 : 0.055);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c, py = y + 0.5 - c;
      const bg = opts.fullBleed ? 1 : cov(sdRoundBox(px, py, c, cornerR));
      const ring = cov(Math.abs(Math.hypot(px, py) - ringR) - ringT);
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) buf[i + ch] = Math.round(PURPLE[ch] + (WHITE[ch] - PURPLE[ch]) * ring);
      buf[i + 3] = Math.round(bg * 255);
    }
  }
  return buf;
}

console.log('Generating icons into public/:');
writePng(path.join(OUT, 'icon-32.png'), 32, render(32, {}));
writePng(path.join(OUT, 'icon-192.png'), 192, render(192, {}));
writePng(path.join(OUT, 'icon-512.png'), 512, render(512, {}));
writePng(path.join(OUT, 'icon-maskable-512.png'), 512, render(512, { fullBleed: true }));
writePng(path.join(OUT, 'apple-touch-icon.png'), 180, render(180, { fullBleed: true }));
