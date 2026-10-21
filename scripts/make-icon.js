'use strict';
// Generates build/icon.png (1024x1024): two linked nodes on a rounded tile.
// electron-builder derives .ico / .icns from it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024, SS = 3;
const px = Buffer.alloc(N * N * 4);

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSeg(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}
const mix = (a, b, t) => a + (b - a) * t;

function shade(x, y) {
  // Background tile with a diagonal blue -> teal gradient.
  if (sdRoundRect(x, y, 512, 512, 440, 440, 190) > 0) return null;
  const t = (x + y) / (2 * N);
  let c = [mix(37, 22, t), mix(99, 160, t), mix(235, 170, t)];
  const A = [330, 640], B = [694, 384];
  const link = sdSeg(x, y, A[0], A[1], B[0], B[1]) - 34;
  const ringA = Math.abs(Math.hypot(x - A[0], y - A[1]) - 112) - 30;
  const ringB = Math.abs(Math.hypot(x - B[0], y - B[1]) - 112) - 30;
  const coreA = Math.hypot(x - A[0], y - A[1]) - 46;
  const coreB = Math.hypot(x - B[0], y - B[1]) - 46;
  const insideA = Math.hypot(x - A[0], y - A[1]) < 112, insideB = Math.hypot(x - B[0], y - B[1]) < 112;
  if (ringA < 0 || ringB < 0 || coreA < 0 || coreB < 0 || (link < 0 && !insideA && !insideB)) c = [255, 255, 255];
  return c;
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    const i = (y * N + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(out, png.length);
