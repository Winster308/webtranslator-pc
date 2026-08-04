'use strict';
/**
 * WebTranslator 图标生成器（零依赖）：生成 256x256 PNG + 内嵌 ICO。
 * 设计：蓝→紫渐变圆角背景 + 白色对白气泡（内有三条翻译文字线）。
 * 用法: node tools/make_icon.js [输出目录]
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;          // 超采样渲染尺寸
const OUT = 256;        // 输出尺寸

// ---------- 形状判定 ----------
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// ---------- 主绘制 ----------
const buf = Buffer.alloc(S * S * 4); // RGBA
const lerp = (a, b, t) => a + (b - a) * t;
const grad = (x, y) => {
  const t = (x + y) / (2 * S); // 对角渐变
  return [Math.round(lerp(79, 124, t)), Math.round(lerp(140, 92, t)), Math.round(lerp(255, 255, t))];
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // 背景圆角矩形（留 24px 边距，透明圆角）
    if (inRoundRect(x, y, 28, 28, S - 28, S - 28, 110)) {
      const [r, g, b] = grad(x, y);
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
      // 左上高光
      const hl = Math.max(0, 1 - Math.hypot(x - S * 0.28, y - S * 0.24) / (S * 0.62));
      if (hl > 0) {
        const a = Math.min(255, buf[i + 3] + Math.round(hl * 26));
        buf[i] = Math.min(255, buf[i] + Math.round(hl * 30));
        buf[i + 1] = Math.min(255, buf[i + 1] + Math.round(hl * 30));
        buf[i + 2] = Math.min(255, buf[i + 2] + Math.round(hl * 30));
        buf[i + 3] = a;
      }
    }
  }
}

// 白色对白气泡（圆角矩形 + 尾巴）
const bubble = (x, y) => {
  if (inRoundRect(x, y, S * 0.14, S * 0.16, S * 0.86, S * 0.66, 42)) return true;
  // 尾巴（左下三角）
  const bx = S * 0.30, by = S * 0.66, bw = S * 0.16, bh = S * 0.18;
  const t = (x - bx) / bw;
  if (t >= 0 && t <= 1 && y >= by && y <= by + bh) {
    const edge = by + t * bh;
    if (y <= edge) return true;
  }
  return false;
};
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (bubble(x, y)) { buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255; }
  }
}

// 气泡内三条"翻译文字"线（渐变蓝色）
const line = (x, y, x0, x1, yy, h) => x >= x0 && x <= x1 && y >= yy && y <= yy + h;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (buf[i + 3] !== 255) continue; // 只画在气泡上
    const inLine = line(x, y, S * 0.26, S * 0.74, S * 0.26, S * 0.045) ||
                   line(x, y, S * 0.26, S * 0.62, S * 0.36, S * 0.045) ||
                   line(x, y, S * 0.26, S * 0.68, S * 0.46, S * 0.045);
    if (inLine) { buf[i] = 79; buf[i + 1] = 140; buf[i + 2] = 255; buf[i + 3] = 255; }
  }
}

// ---------- 降采样到 OUT ----------
const out = Buffer.alloc(OUT * OUT * 4);
const k = S / OUT;
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = 0; sy < k; sy++) {
      for (let sx = 0; sx < k; sx++) {
        const i = ((y * k + sy) * S + (x * k + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]; n++;
      }
    }
    const o = (y * OUT + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
}

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO（内嵌 256 PNG） ----------
function makeIco(png) {
  const dir = Buffer.alloc(6 + 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  dir[6] = 0; dir[7] = 0; dir[8] = 0; dir[9] = 0; // 256x256
  dir[10] = 0; dir[11] = 0; dir[12] = 1; dir[13] = 0; // 32bpp
  dir.writeUInt32LE(png.length, 14);
  dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, png]);
}

const png = makePng(OUT, out);
const outDir = process.argv[2] || path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeIco(png));
console.log(`已生成: ${path.join(outDir, 'icon.png')} (${png.length} bytes) + icon.ico`);
