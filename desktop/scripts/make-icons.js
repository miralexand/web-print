'use strict';

/**
 * 生成托盘/应用图标：build/icon.png(256)、build/tray.png(32)、build/icon.ico
 * 纯 Node 实现，无需额外依赖。运行：node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, color, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = alpha / 255;
    buf[i] = Math.round(buf[i] * (1 - a) + color[0] * a);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + color[1] * a);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + color[2] * a);
    buf[i + 3] = Math.max(buf[i + 3], alpha);
  };
  return { buf, put };
}

function roundRect(put, size, x0, y0, x1, y1, radius, color) {
  const rx0 = x0 * size;
  const ry0 = y0 * size;
  const rx1 = x1 * size;
  const ry1 = y1 * size;
  const r = radius * size;
  for (let y = Math.floor(ry0); y < Math.ceil(ry1); y += 1) {
    for (let x = Math.floor(rx0); x < Math.ceil(rx1); x += 1) {
      const cx = Math.min(Math.max(x + 0.5, rx0 + r), rx1 - r);
      const cy = Math.min(Math.max(y + 0.5, ry0 + r), ry1 - r);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) put(x, y, color);
    }
  }
}

function drawPrinter(size) {
  const { buf, put } = makeCanvas(size);
  roundRect(put, size, 0.06, 0.06, 0.94, 0.94, 0.22, BLUE);
  // 顶部进纸
  roundRect(put, size, 0.30, 0.20, 0.70, 0.46, 0.04, WHITE);
  // 打印机主体
  roundRect(put, size, 0.18, 0.40, 0.82, 0.72, 0.07, WHITE);
  // 出纸口
  roundRect(put, size, 0.30, 0.62, 0.70, 0.84, 0.04, WHITE);
  // 纸张槽（蓝色条）
  roundRect(put, size, 0.24, 0.47, 0.76, 0.53, 0.02, BLUE);
  // 状态灯
  roundRect(put, size, 0.70, 0.65, 0.76, 0.71, 0.03, BLUE);
  return buf;
}

function buildIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0; // 256
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

fs.mkdirSync(OUT, { recursive: true });
const icon256 = encodePng(256, 256, drawPrinter(256));
const tray32 = encodePng(32, 32, drawPrinter(32));
fs.writeFileSync(path.join(OUT, 'icon.png'), icon256);
fs.writeFileSync(path.join(OUT, 'tray.png'), tray32);
fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(icon256));
console.log('icons written to', OUT);
