'use strict';

const path = require('path');

const ALLOWED_EXT = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.txt': 'text',
  '.doc': 'office',
  '.docx': 'office',
  '.xls': 'office',
  '.xlsx': 'office',
  '.ppt': 'office',
  '.pptx': 'office',
};

const DANGEROUS_EXT = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi',
  '.sh', '.ps1', '.js', '.vbs', '.jar', '.php', '.py', '.html', '.htm',
]);

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

// 通过文件头（magic number）进一步校验，防止改后缀绕过
function checkMagic(ext, buf) {
  switch (ext) {
    case '.pdf':
      return startsWith(buf, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case '.png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]);
    case '.jpg':
    case '.jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case '.docx':
    case '.xlsx':
    case '.pptx':
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]); // ZIP
    case '.txt':
      // 纯文本没有魔数可校验；拒绝含 NUL 的内容，避免二进制文件伪装成文本
      return !buf.includes(0);
    case '.doc':
    case '.xls':
    case '.ppt':
      return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0]); // OLE2
    default:
      return true;
  }
}

/**
 * 校验上传文件，返回 { ok, error, ext, kind }。
 * @param {{originalname:string, buffer:Buffer, size:number}} file
 * @param {number} maxSize
 */
function validateUpload(file, maxSize) {
  if (!file || !file.buffer) {
    return { ok: false, error: '未接收到文件' };
  }
  if (file.size > maxSize) {
    return { ok: false, error: `文件超过大小限制（最大 ${Math.round(maxSize / 1024 / 1024)}MB）` };
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (DANGEROUS_EXT.has(ext)) {
    return { ok: false, error: `禁止上传的文件类型：${ext}` };
  }
  if (!ALLOWED_EXT[ext]) {
    return { ok: false, error: `不支持的文件类型：${ext || '未知'}，仅支持 PDF / 图片 / Office 文档 / 文本` };
  }
  if (!checkMagic(ext, file.buffer)) {
    return { ok: false, error: '文件内容与扩展名不匹配，已拒绝' };
  }
  return { ok: true, ext, kind: ALLOWED_EXT[ext] };
}

module.exports = { validateUpload, ALLOWED_EXT };
