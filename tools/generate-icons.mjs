// Generates the extension icons (16/32/48/128 px) with zero dependencies.
// Usage: node tools/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- tiny PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // filter each scanline: prepend 0 (None)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- drawing helpers ----------
function lerp(a, b, t) { return a + (b - a) * t; }

function roundedRectCoverage(x0, y0, x1, y1, r, px, py, samples = 3) {
  let hit = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = px + (sx + 0.5) / samples;
      const y = py + (sy + 0.5) / samples;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const cx = Math.max(x0 + r, Math.min(x, x1 - r));
      const cy = Math.max(y0 + r, Math.min(y, y1 - r));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
  }
  return hit / (samples * samples);
}

function circleCoverage(cx, cy, radius, px, py, samples = 3) {
  let hit = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = px + (sx + 0.5) / samples;
      const y = py + (sy + 0.5) / samples;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) hit++;
    }
  }
  return hit / (samples * samples);
}

function rectHit(x0, y0, x1, y1, px, py) {
  return px >= x0 && px < x1 && py >= y0 && py < y1;
}

// ---------- icon design: "{•}" on a slate gradient rounded square ----------
function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const BG_A = [13, 20, 38];   // #0d1426 top-left
  const BG_B = [30, 41, 66];   // #1e2942 bottom-right
  const WHITE = [241, 245, 249];
  const TEAL = [45, 212, 191]; // #2dd4bf

  const m = 0.06; // margin
  const r = 0.24; // corner radius

  // normalized "{ }" glyph geometry
  const barW = 0.055;
  const armW = 0.11;
  const armT = 0.055;
  const vTop = 0.30, vBot = 0.70;
  const leftBarX = 0.225, rightBarX = 0.775 - barW;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size, py = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      const cover = roundedRectCoverage(m, m, 1 - m, 1 - m, r, px, py);
      if (cover <= 0) { buf[i + 3] = 0; continue; }

      // background gradient
      const g = (px + py) / 2;
      let cr = lerp(BG_A[0], BG_B[0], g), cg = lerp(BG_A[1], BG_B[1], g), cb = lerp(BG_A[2], BG_B[2], g);

      const dot = circleCoverage(0.5, 0.5, 0.085, px, py);
      const isBrace =
        (rectHit(leftBarX, vTop, leftBarX + barW, vBot, px, py)) ||
        (rectHit(leftBarX, vTop, leftBarX + armW, vTop + armT, px, py)) ||
        (rectHit(leftBarX, vBot - armT, leftBarX + armW, vBot, px, py)) ||
        (rectHit(rightBarX, vTop, rightBarX + barW, vBot, px, py)) ||
        (rectHit(rightBarX + barW - armW, vTop, rightBarX + barW, vTop + armT, px, py)) ||
        (rectHit(rightBarX + barW - armW, vBot - armT, rightBarX + barW, vBot, px, py));

      if (isBrace) {
        cr = lerp(cr, WHITE[0], 0.96); cg = lerp(cg, WHITE[1], 0.96); cb = lerp(cb, WHITE[2], 0.96);
      }
      if (dot > 0) {
        cr = lerp(cr, TEAL[0], dot); cg = lerp(cg, TEAL[1], dot); cb = lerp(cb, TEAL[2], dot);
      }

      buf[i] = Math.round(cr);
      buf[i + 1] = Math.round(cg);
      buf[i + 2] = Math.round(cb);
      buf[i + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(size, size, buf);
}

for (const size of [16, 32, 48, 128]) {
  const png = renderIcon(size);
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
