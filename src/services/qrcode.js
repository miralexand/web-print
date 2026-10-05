'use strict';

/**
 * 纯 JavaScript 二维码（QR Code）编码器 —— 零第三方依赖。
 *
 * 支持范围：
 *   - 仅字节模式（byte mode）：输入按 UTF-8 编码为字节流；
 *   - 纠错级别 L / M（默认 M）；
 *   - 版本 1 ~ 10（21x21 ~ 57x57），自动选择能容纳数据的最小版本；
 *   - 数据超出版本 10 容量时抛出 Error。
 *
 * 导出：
 *   encode(text, options) -> { version, ecc, size, modules, mask }
 *   toSvg(text, options)  -> SVG 字符串
 *
 * 实现要点：GF(256) Reed-Solomon 纠错、分块交织、8 种数据掩码 + 惩罚分评估、
 * 格式信息与版本信息的 BCH 编码、定位/分隔/定时/校正图形与固定暗模块。
 */

// ===========================================================================
// 1. GF(256) 伽罗华域运算（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D）
// ===========================================================================

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

/** 伽罗华域 GF(256) 乘法 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成多项式缓存：key 为阶数 */
const generatorCache = new Map();

/**
 * 构造生成多项式 g(x) = (x - α^0)(x - α^1)...(x - α^(degree-1))。
 * 返回长度为 degree+1 的系数数组，poly[0] 为最高次项（恒为 1）。
 */
function rsGeneratorPoly(degree) {
  const cached = generatorCache.get(degree);
  if (cached) return cached;
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let k = 0; k < poly.length; k += 1) {
      next[k] ^= poly[k];                            // 乘以 x（整体升幂）
      next[k + 1] ^= gfMul(poly[k], GF_EXP[i]);      // 乘以 α^i
    }
    poly = next;
  }
  generatorCache.set(degree, poly);
  return poly;
}

/** 计算 data 码字的 degree 个 Reed-Solomon 纠错码字 */
function rsEncode(data, degree) {
  const gen = rsGeneratorPoly(degree);
  const rem = new Array(degree).fill(0);
  for (let d = 0; d < data.length; d += 1) {
    const factor = data[d] ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ===========================================================================
// 2. 版本 / 纠错参数表（版本 1 ~ 10）
// ===========================================================================

/** 各版本总码字数（数据 + 纠错） */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * 分块表。ECC_TABLE[级别][版本-1] =
 *   [每块纠错码字数, 第1组块数, 第1组每块数据码字数, 第2组块数, 第2组每块数据码字数]
 */
const ECC_TABLE = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
};

/** 校正图形中心坐标表（版本 1 无校正图形） */
const ALIGNMENT_POSITIONS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 格式信息中的纠错级别编码（2 bit） */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** 校验并归一化纠错级别 */
function normalizeEcc(value) {
  if (value === undefined || value === null || value === '') return 'M';
  const ecc = String(value).toUpperCase();
  if (ecc !== 'L' && ecc !== 'M') {
    throw new Error(`不支持的纠错级别 "${value}"：本模块仅支持 L 与 M`);
  }
  return ecc;
}

/** 取某版本 + 纠错级别的分块参数，并校验总码字数 */
function blockInfo(version, ecc) {
  const info = ECC_TABLE[ecc][version - 1];
  const [ecPerBlock, blocks1, data1, blocks2, data2] = info;
  const total = ecPerBlock * (blocks1 + blocks2) + blocks1 * data1 + blocks2 * data2;
  if (total !== TOTAL_CODEWORDS[version - 1]) {
    throw new Error(`内部参数表错误：版本 ${version} / 级别 ${ecc}`);
  }
  return { ecPerBlock, blocks1, data1, blocks2, data2, totalDataCodewords: blocks1 * data1 + blocks2 * data2 };
}

/** 字符计数指示符位宽：版本 1~9 为 8 bit，版本 10~26 为 16 bit */
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 某版本 + 级别在字节模式下可容纳的最大字节数 */
function dataCapacityBytes(version, ecc) {
  const { totalDataCodewords } = blockInfo(version, ecc);
  const available = totalDataCodewords * 8 - 4 - charCountBits(version);
  return Math.floor(available / 8);
}

// ===========================================================================
// 3. BCH 编码：格式信息与版本信息
// ===========================================================================

/** 15 bit 格式信息 = 5 bit 数据 + 10 bit BCH，再与 0x5412 异或 */
function formatInfoBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 18 bit 版本信息 = 6 bit 版本号 + 12 bit BCH（生成多项式 0x1F25） */
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

// ===========================================================================
// 4. 数据掩码（8 种）
// ===========================================================================

/* eslint-disable no-bitwise */
const MASK_FUNCS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
/* eslint-enable no-bitwise */

// ===========================================================================
// 5. 矩阵构造
// ===========================================================================

/** 绘制格式信息（第一份在左上，第二份在右上 + 左下），并标记为功能模块 */
function drawFormatBits(modules, isFunction, size, ecc, mask) {
  const bits = formatInfoBits(ecc, mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));

  set(8, size - 8, true); // 固定暗模块
}

/** 惩罚规则 1：同色连续模块 >= 5 时计分 */
function penaltyRule1Line(line) {
  let score = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLen += 1;
    } else {
      if (runLen >= 5) score += 3 + (runLen - 5);
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) score += 3 + (runLen - 5);
  return score;
}

/** 惩罚规则 3 的两个 11 模块特征串：1:1:3:1:1 前后各有 4 个浅色模块 */
const FINDER_LIKE = [
  [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
];

/** 惩罚规则 3：在一行/一列中统计 1:1:3:1:1 且一侧有 4 个浅色模块的特征串 */
function penaltyRule3Line(line) {
  let count = 0;
  const limit = line.length - 11;
  for (let i = 0; i <= limit; i += 1) {
    for (let p = 0; p < FINDER_LIKE.length; p += 1) {
      const pat = FINDER_LIKE[p];
      let ok = true;
      for (let k = 0; k < 11; k += 1) {
        if (line[i + k] !== (pat[k] === 1)) { ok = false; break; }
      }
      if (ok) { count += 1; break; }
    }
  }
  return count * 40;
}

/** 计算整幅矩阵的掩码惩罚分 */
function computePenalty(modules, size) {
  let score = 0;

  // 规则 1 & 3：逐行、逐列
  for (let y = 0; y < size; y += 1) {
    score += penaltyRule1Line(modules[y]);
    score += penaltyRule3Line(modules[y]);
  }
  const col = new Array(size);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) col[y] = modules[y][x];
    score += penaltyRule1Line(col);
    score += penaltyRule3Line(col);
  }

  // 规则 2：同色 2x2 块
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // 规则 4：深色比例偏离 50% 的程度，每偏离 5% 计 10 分
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * 构造最终模块矩阵。
 * 流程：功能图形 -> 预留格式/版本信息 -> 之字形填充数据 -> 8 种掩码择优。
 */
function buildMatrix(version, ecc, codewords) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let y = 0; y < size; y += 1) {
    modules.push(new Array(size).fill(false));
    isFunction.push(new Array(size).fill(false));
  }

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // --- 定时图形 ---
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // --- 定位图形 + 分隔符 ---
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // --- 校正图形（跳过与定位图形重叠的三处）---
  const positions = ALIGNMENT_POSITIONS[version - 1];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const cx = positions[i];
      const cy = positions[j];
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // --- 预留格式信息区域（先用掩码 0 占位，稍后按真实掩码重绘）---
  drawFormatBits(modules, isFunction, size, ecc, 0);

  // --- 版本信息（版本 >= 7）---
  if (version >= 7) {
    const vbits = versionInfoBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((vbits >>> i) & 1) !== 0;
      setFunction(size - 11 + (i % 3), Math.floor(i / 3), bit); // 右上
      setFunction(Math.floor(i / 3), size - 11 + (i % 3), bit); // 左下
    }
  }

  // --- 之字形填充数据码字（未加掩码）---
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖直定时图形所在列
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < totalBits) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex += 1;
        }
      }
    }
  }

  // --- 8 种掩码，取惩罚分最低者 ---
  let bestModules = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => row.slice());
    const fn = MASK_FUNCS[mask];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!isFunction[y][x] && fn(x, y)) candidate[y][x] = !candidate[y][x];
      }
    }
    drawFormatBits(candidate, isFunction, size, ecc, mask);
    const score = computePenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  return { size, modules: bestModules, mask: bestMask, penalty: bestScore };
}

// ===========================================================================
// 6. 编码主流程
// ===========================================================================

/** 把数据码字按分块表切块、RS 纠错、交织成最终码字序列 */
function makeCodewords(version, ecc, dataCodewords) {
  const { ecPerBlock, blocks1, data1, blocks2, data2 } = blockInfo(version, ecc);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < blocks1 + blocks2; i += 1) {
    const len = i < blocks1 ? data1 : data2;
    const data = dataCodewords.slice(offset, offset + len);
    offset += len;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }

  const result = [];
  const maxDataLen = blocks2 > 0 ? Math.max(data1, data2) : data1;
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < blocks[b].data.length) result.push(blocks[b].data[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) result.push(blocks[b].ec[i]);
  }
  return result;
}

/** 字节模式下构造数据码字（模式指示符 + 字符计数 + 数据 + 终止符 + 填充） */
function makeDataCodewords(version, ecc, bytes) {
  const { totalDataCodewords } = blockInfo(version, ecc);
  const capacityBits = totalDataCodewords * 8;
  const bits = [];

  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  pushBits(0b0100, 4);                                   // 字节模式指示符
  pushBits(bytes.length, charCountBits(version));        // 字符计数
  for (let i = 0; i < bytes.length; i += 1) pushBits(bytes[i], 8);

  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);            // 补齐字节边界

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }

  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < totalDataCodewords) {
    codewords.push(PAD[padIndex % 2]);
    padIndex += 1;
  }
  return codewords;
}

/**
 * 编码为二维码模块矩阵。
 * @param {string} text 待编码文本（按 UTF-8 编码）
 * @param {{ecc?: 'L'|'M'}} [options]
 * @returns {{version:number, ecc:string, size:number, modules:boolean[][]}}
 */
function encode(text, options) {
  if (typeof text !== 'string') {
    throw new TypeError('encode(text, options): text 必须是字符串');
  }
  const opts = options || {};
  const ecc = normalizeEcc(opts.ecc);
  const bytes = Buffer.from(text, 'utf8');

  let version = -1;
  for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
    if (dataCapacityBytes(v, ecc) >= bytes.length) { version = v; break; }
  }
  if (version < 0) {
    const max = dataCapacityBytes(MAX_VERSION, ecc);
    throw new Error(
      `输入数据过长：UTF-8 编码后 ${bytes.length} 字节，超出版本 ${MAX_VERSION}（纠错级别 ${ecc}）的最大容量 ${max} 字节`
    );
  }

  const dataCodewords = makeDataCodewords(version, ecc, bytes);
  const codewords = makeCodewords(version, ecc, dataCodewords);
  const matrix = buildMatrix(version, ecc, codewords);

  return {
    version,
    ecc,
    size: matrix.size,
    modules: matrix.modules,
  };
}

// ===========================================================================
// 7. SVG 输出
// ===========================================================================

/** XML 属性值转义 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 归一化为正整数 */
function toPositiveInt(value, fallback, min) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  return i < min ? min : i;
}

/**
 * 生成二维码 SVG。
 * 每个深色模块一个 <rect>，外加一个浅色背景 <rect>（共 darkCount + 1 个 <rect>）。
 * @param {string} text
 * @param {{ecc?:'L'|'M', scale?:number, margin?:number, dark?:string, light?:string}} [options]
 * @returns {string}
 */
function toSvg(text, options) {
  const opts = options || {};
  const scale = toPositiveInt(opts.scale, 8, 1);
  const margin = toPositiveInt(opts.margin, 4, 0);
  const dark = typeof opts.dark === 'string' && opts.dark !== '' ? opts.dark : '#000000';
  const light = typeof opts.light === 'string' && opts.light !== '' ? opts.light : '#ffffff';

  const { size, modules } = encode(text, opts);
  const dim = (size + margin * 2) * scale;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
  );
  parts.push(`<rect x="0" y="0" width="${dim}" height="${dim}" fill="${escapeAttr(light)}"/>`);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y][x]) continue;
      parts.push(
        `<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" ` +
        `width="${scale}" height="${scale}" fill="${escapeAttr(dark)}"/>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

module.exports = {
  encode,
  toSvg,
};
