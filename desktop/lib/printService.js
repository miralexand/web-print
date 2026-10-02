'use strict';

/**
 * 打包进 Electron 的本地打印服务核心（与 host-print-agent/agent.js 功能一致）。
 * - 支持可配置的 URL 路径前缀（basePath），便于通过 Cloudflare 隧道以“域名 + 路径”暴露
 * - Office 转 PDF 使用独立 LibreOffice 用户配置目录，避免并发/占用导致的转换失败
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { print, getPrinters } = require('pdf-to-printer');

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice 7\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice 6\\program\\soffice.exe',
    'D:\\Program Files\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return 'soffice';
}

function normalizeBasePath(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}

/**
 * 修复 multipart 文件名乱码：busboy 默认按 latin1 解析，中文名会变乱码。
 * 如果字符串本身已含真正的 Unicode（CJK 等），则原样返回。
 */
function decodeFilename(name) {
  if (!name) return name;
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch (_) {
    return name;
  }
}

class PrintService {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number.parseInt(options.port, 10) || 8081;
    this.token = options.token || '';
    this.basePath = normalizeBasePath(options.basePath);
    this.sofficePath = options.sofficePath || findSoffice();
    this.workDir = options.workDir || path.join(os.tmpdir(), 'webprint-agent');
    this.uploadDir = path.join(this.workDir, 'uploads');
    this.convertDir = path.join(this.workDir, 'converted');
    this.server = null;
    this.running = false;
    this.logs = [];
  }

  log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.shift();
    console.log(line);
  }

  cleanup(...paths) {
    for (const p of paths) {
      if (!p) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  latestPdf(dir) {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .map((f) => {
          const p = path.join(dir, f);
          return { p, t: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.t - a.t);
      return files.length ? files[0].p : null;
    } catch (_) {
      return null;
    }
  }

  /** 使用独立用户配置目录将 Office / 图片转成 PDF，失败自动重试一次 */
  convertToPdf(filePath) {
    const outDir = this.convertDir;
    fs.mkdirSync(outDir, { recursive: true });
    const expected = path.join(outDir, path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf');
    const profileDir = path.join(this.workDir, `lo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const profileUri = `file:///${profileDir.replace(/\\/g, '/')}`;
    const args = [
      '--headless', '--nologo', '--nofirststartwizard', '--norestore', '--invisible',
      `-env:UserInstallation=${profileUri}`,
      '--convert-to', 'pdf', '--outdir', outDir, filePath,
    ];

    const runOnce = () => new Promise((resolve) => {
      execFile(this.sofficePath, args, { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, output: `${stdout || ''}${stderr || ''}`.trim() });
      });
    });

    return (async () => {
      fs.mkdirSync(profileDir, { recursive: true });
      try {
        let result = await runOnce();
        if (!result.err && fs.existsSync(expected)) return expected;
        for (let i = 0; i < 10; i += 1) {
          await new Promise((r) => setTimeout(r, 300));
          if (fs.existsSync(expected)) return expected;
        }
        result = await runOnce();
        if (!result.err && fs.existsSync(expected)) return expected;
        const found = this.latestPdf(outDir);
        if (found) return found;
        throw new Error(`LibreOffice 转换失败：${result.output || (result.err && result.err.message) || '请检查 LibreOffice 安装路径'}`);
      } finally {
        this.cleanup(profileDir);
      }
    })();
  }

  buildRouter() {
    const router = express.Router();

    router.use((req, res, next) => {
      if (this.token && req.get('x-print-token') !== this.token) {
        return res.status(401).json({ success: false, message: '令牌校验失败' });
      }
      return next();
    });

    router.get('/health', async (req, res) => {
      let printerCount = 0;
      try {
        printerCount = (await getPrinters()).length;
      } catch (_) {
        /* ignore */
      }
      res.json({ ok: true, service: 'web-print-agent', basePath: this.basePath, soffice: this.sofficePath, printers: printerCount });
    });

    router.get('/printers', async (req, res) => {
      try {
        res.json({ printers: await getPrinters() });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message, printers: [] });
      }
    });

    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, this.uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(decodeFilename(file.originalname) || '').toLowerCase();
        const safeExt = /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
      },
    });
    const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

    router.post('/print', upload.single('file'), async (req, res) => {
      if (!req.file) return res.status(400).json({ success: false, message: '未接收到文件' });
      const uploadedPath = req.file.path;
      let pdfPath = uploadedPath;
      let convertedPath = null;
      const originalName = decodeFilename(req.file.originalname || '');
      const ext = path.extname(originalName).toLowerCase();
      const copies = Math.min(Math.max(Number.parseInt(req.body.copies, 10) || 1, 1), 99);
      const color = req.body.color === 'color' ? 'color' : 'mono';
      const paperSize = (req.body.paperSize || '').trim();
      const printer = (req.body.printer || '').trim();
      const jobId = (req.body.jobId || '').trim();
      try {
        if (ext && ext !== '.pdf') {
          this.log(`任务 ${jobId}: 转换 ${ext} -> PDF`);
          convertedPath = await this.convertToPdf(uploadedPath);
          pdfPath = convertedPath;
        }
        const options = { copies };
        if (printer) options.printer = printer;
        if (color === 'mono') options.monochrome = true;
        if (paperSize) options.paperSize = paperSize;
        this.log(`任务 ${jobId}: 提交打印 -> ${printer || '默认打印机'}`);
        await print(pdfPath, options);
        this.log(`任务 ${jobId}: 打印提交成功`);
        return res.json({ success: true, message: '打印任务已提交' });
      } catch (err) {
        this.log(`任务 ${jobId}: 打印失败 - ${err.message}`);
        return res.status(500).json({ success: false, message: err.message });
      } finally {
        this.cleanup(uploadedPath, convertedPath);
      }
    });

    return router;
  }

  buildApp() {
    const app = express();
    app.disable('x-powered-by');
    const router = this.buildRouter();
    // 同时支持根路径与自定义前缀（Cloudflare 隧道可按“域名 + 路径”转发）
    if (this.basePath) app.use(this.basePath, router);
    app.use('/', router);
    app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));
    return app;
  }

  start() {
    if (this.running) return Promise.resolve(this.status());
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.convertDir, { recursive: true });
    if (!this.sofficePath) this.sofficePath = findSoffice();
    const app = this.buildApp();
    return new Promise((resolve, reject) => {
      const server = app.listen(this.port, this.host, () => {
        this.server = server;
        this.running = true;
        this.log(`打印服务已启动：http://${this.host}:${this.port}${this.basePath}`);
        resolve(this.status());
      });
      server.on('error', (err) => {
        this.running = false;
        reject(err);
      });
    });
  }

  stop() {
    if (!this.running || !this.server) {
      this.running = false;
      return Promise.resolve(this.status());
    }
    return new Promise((resolve) => {
      this.server.close(() => {
        this.running = false;
        this.server = null;
        this.log('打印服务已停止');
        resolve(this.status());
      });
    });
  }

  async listPrinters() {
    return getPrinters();
  }

  status() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      token: this.token,
      basePath: this.basePath,
      sofficePath: this.sofficePath,
    };
  }
}

module.exports = { PrintService, findSoffice, decodeFilename, normalizeBasePath };
