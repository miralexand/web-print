'use strict';

/**
 * Windows 宿主机打印 Agent
 * ------------------------------------------------------------
 * 职责：
 *   1. 接收 Docker Web 服务 POST 过来的待打印文件
 *   2. Office / 图片用本机 LibreOffice 转成 PDF
 *   3. 用 pdf-to-printer 调用 Windows 打印驱动，提交到指定 / 默认打印机
 *
 * 仅监听 127.0.0.1，禁止暴露到外网。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { print, getPrinters } = require('pdf-to-printer');

const PORT = Number.parseInt(process.env.PORT, 10) || 8081;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_TOKEN || '';
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'webprint-agent');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const CONVERT_DIR = path.join(WORK_DIR, 'converted');
const SOFFICE = process.env.SOFFICE_PATH || findSoffice();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CONVERT_DIR, { recursive: true });

function findSoffice() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'soffice';
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function cleanup(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

/** 用 LibreOffice 将 Office / 图片转成 PDF，返回生成的 PDF 路径 */
function convertToPdf(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      SOFFICE,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', CONVERT_DIR, filePath],
      { timeout: 120000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`LibreOffice 转换失败：${(stderr || err.message || '').trim() || '请检查 SOFFICE_PATH'}`));
        }
        const base = path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf';
        const outPath = path.join(CONVERT_DIR, base);
        if (!fs.existsSync(outPath)) {
          return reject(new Error('转换完成但未找到生成的 PDF 文件'));
        }
        return resolve(outPath);
      }
    );
  });
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (TOKEN && req.get('x-print-token') !== TOKEN) {
    return res.status(401).json({ success: false, message: '令牌校验失败' });
  }
  return next();
});

app.get('/health', async (req, res) => {
  let printerCount = 0;
  try {
    printerCount = (await getPrinters()).length;
  } catch (_) {
    /* ignore */
  }
  res.json({ ok: true, service: 'web-print-agent', soffice: SOFFICE, printers: printerCount });
});

app.get('/printers', async (req, res) => {
  try {
    const printers = await getPrinters();
    res.json({ printers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, printers: [] });
  }
});

app.post('/print', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '未接收到文件' });
  }

  const uploadedPath = req.file.path;
  let pdfPath = uploadedPath;
  let convertedPath = null;

  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const copies = Math.min(Math.max(Number.parseInt(req.body.copies, 10) || 1, 1), 99);
  const color = req.body.color === 'color' ? 'color' : 'mono';
  const paperSize = (req.body.paperSize || '').trim();
  const printer = (req.body.printer || '').trim();
  const jobId = (req.body.jobId || '').trim();

  try {
    if (ext && ext !== '.pdf') {
      log(`任务 ${jobId}: 转换 ${ext} -> PDF`);
      convertedPath = await convertToPdf(uploadedPath);
      pdfPath = convertedPath;
    }

    const options = { copies };
    if (printer) options.printer = printer;
    if (color === 'mono') options.monochrome = true;
    if (paperSize) options.paperSize = paperSize;

    log(`任务 ${jobId}: 提交打印 -> ${printer || '默认打印机'}（${copies} 份，${color}，${paperSize || '默认纸张'}）`);
    await print(pdfPath, options);
    log(`任务 ${jobId}: 打印提交成功`);

    return res.json({ success: true, message: '打印任务已提交' });
  } catch (err) {
    log(`任务 ${jobId}: 打印失败 - ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    cleanup(uploadedPath, convertedPath);
  }
});

app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));

app.listen(PORT, HOST, () => {
  log(`打印 Agent 已启动：http://${HOST}:${PORT}`);
  log(`LibreOffice 路径：${SOFFICE}`);
  if (!TOKEN) {
    log('提示：未设置 AGENT_TOKEN，接口未启用令牌校验（仅本机访问，风险可控）');
  }
});
