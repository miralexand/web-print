'use strict';

/**
 * 浏览器端「图片 → 单页 PDF」转换（零依赖）。
 *
 * 背景：PNG / JPG 直接交给打印主机的 Office/WPS COM 转 PDF 不稳定，
 * 因此改在客户端网页里把图片画到 canvas、编码为 JPEG，再嵌入一个最小 PDF，
 * 以 PDF 形式提交给服务端，服务端只需处理 PDF。
 *
 * 同时以 UMD 形式导出，便于在 Node 里对核心函数 buildImagePdf 做单元测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WebPrintPdf = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 纸张尺寸（单位 point，1pt = 1/72 inch）
  const PAPER_SIZES = {
    A3: [841.89, 1190.55],
    A4: [595.28, 841.89],
    A5: [419.53, 595.28],
    B5: [498.9, 708.66],
    Letter: [612, 792],
    Legal: [612, 1008],
  };

  const DEFAULT_MARGIN = 24; // pt，约 8.5mm

  function fmt(n) {
    return String(Math.round(n * 1000) / 1000);
  }

  function encodeAscii(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * 把一段 JPEG 字节嵌入为单页 PDF。
   * @param {Uint8Array} jpeg JPEG 原始字节
   * @param {number} iw 图片像素宽
   * @param {number} ih 图片像素高
   * @param {number} pageW 页面宽（pt）
   * @param {number} pageH 页面高（pt）
   * @param {number} [margin] 页边距（pt），缺省 24
   * @returns {Uint8Array} PDF 字节
   */
  function buildImagePdf(jpeg, iw, ih, pageW, pageH, margin) {
    const m = margin == null ? DEFAULT_MARGIN : margin;
    const availW = Math.max(1, pageW - m * 2);
    const availH = Math.max(1, pageH - m * 2);
    const fit = Math.min(availW / iw, availH / ih);
    const dw = iw * fit;
    const dh = ih * fit;
    const x = (pageW - dw) / 2;
    const y = (pageH - dh) / 2;

    const content = `q\n${fmt(dw)} 0 0 ${fmt(dh)} ${fmt(x)} ${fmt(y)} cm\n/Im0 Do\nQ\n`;
    const contentBytes = encodeAscii(content);

    const chunks = [];
    let len = 0;
    const push = (u8) => { chunks.push(u8); len += u8.length; };
    const pushStr = (s) => push(encodeAscii(s));

    const offsets = [0];
    pushStr('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制标记注释

    offsets[1] = len;
    pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    offsets[2] = len;
    pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    offsets[3] = len;
    pushStr(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
      `${fmt(pageW)} ${fmt(pageH)}] /Resources << /XObject << /Im0 5 0 R >> >> ` +
      '/Contents 4 0 R >>\nendobj\n'
    );
    offsets[4] = len;
    pushStr(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    pushStr('endstream\nendobj\n');
    offsets[5] = len;
    pushStr(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    push(jpeg);
    pushStr('\nendstream\nendobj\n');

    const xrefStart = len;
    pushStr('xref\n0 6\n');
    pushStr('0000000000 65535 f \n');
    for (let i = 1; i <= 5; i += 1) {
      pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    }
    pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const out = new Uint8Array(len);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }

  function isImageFile(file) {
    if (!file) return false;
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type === 'image/png' || type === 'image/jpeg' || /\.(png|jpe?g)$/.test(name);
  }

  function loadImageElement(file) {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve({
        draw: el,
        width: el.naturalWidth || el.width,
        height: el.naturalHeight || el.height,
        cleanup: () => URL.revokeObjectURL(url),
      });
      el.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败'));
      };
      el.src = url;
    });
  }

  async function loadSource(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          draw: bmp,
          width: bmp.width,
          height: bmp.height,
          cleanup: () => { if (typeof bmp.close === 'function') bmp.close(); },
        };
      } catch (_) {
        /* 个别浏览器不支持该选项，退回到 <img> 解码 */
      }
    }
    return loadImageElement(file);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('图片编码为 JPEG 失败'))),
        type,
        quality
      );
    });
  }

  /**
   * 把图片 File 转换为单页 PDF File。
   * @param {File} file
   * @param {{paperSize?:string, quality?:number, maxSide?:number, margin?:number}} [options]
   * @returns {Promise<File>}
   */
  async function imageFileToPdf(file, options) {
    const opts = options || {};
    const source = await loadSource(file);
    try {
      const iw = source.width;
      const ih = source.height;
      if (!iw || !ih) throw new Error('无法读取图片尺寸');

      const maxSide = opts.maxSide || 3000;
      const scale = Math.min(1, maxSide / Math.max(iw, ih));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(iw * scale));
      canvas.height = Math.max(1, Math.round(ih * scale));
      const ctx = canvas.getContext('2d');
      // JPEG 不支持透明通道，先铺白底，避免 PNG 透明区域变成黑块
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source.draw, 0, 0, canvas.width, canvas.height);

      const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', opts.quality || 0.92);
      const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());

      const page = PAPER_SIZES[opts.paperSize] || PAPER_SIZES.A4;
      const bytes = buildImagePdf(jpeg, canvas.width, canvas.height, page[0], page[1], opts.margin);
      const base = String(file.name || '图片').replace(/\.[^.]+$/, '');
      return new File([bytes], `${base}.pdf`, { type: 'application/pdf' });
    } finally {
      if (source.cleanup) source.cleanup();
    }
  }

  return { imageFileToPdf, buildImagePdf, isImageFile, PAPER_SIZES };
});
