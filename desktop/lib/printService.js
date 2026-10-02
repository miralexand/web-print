'use strict';

/**
 * 打包进 Electron 的本地打印服务核心。
 * 与 host-print-agent/agent.js 功能一致，被托盘应用内嵌启动。
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
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'soffice';
}

class PrintService {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number.parseInt(options.port, 10) || 8081;
    this.token = options.token || '';
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
        fs.rmSync(p, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  convertToPdf(filePath) {
    return new Promise((resolve, reject) => {
      execFile(
        this.sofficePath,
        ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', this.convertDir, filePath],
        { timeout: 120000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            return reject(new Error(`LibreOffice 转换失败：${(stderr || err.message || '').trim() || '请检查 LibreOffice 路径'}`));
          }
          const base = path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf';
          const outPath = path.join(this.convertDir, base);
          if (!fs.existsSync(outPath)) {
            return reject(new Error('转换完成但未找到生成的 PDF 文件'));
          }
          return resolve(outPath);
        }
      );
    });
  }

  buildApp() {
    const app = express();
    app.disable('x-powered-by');

    app.use((req, res, next) => {
      if (this.token && req.get('x-print-token') !== this.token) {
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
      res.json({ ok: true, service: 'web-print-agent', soffice: this.sofficePath, printers: printerCount });
    });

    app.get('/printers', async (req, res) => {
      try {
        res.json({ printers: await getPrinters() });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message, printers: [] });
      }
    });

    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, this.uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const safeExt = /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
      },
    });
    const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

    app.post('/print', upload.single('file'), async (req, res) => {
      if (!req.file) return res.status(400).json({ success: false, message: '未接收到文件' });
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
        this.log(`打印服务已启动：http://${this.host}:${this.port}`);
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
      sofficePath: this.sofficePath,
    };
  }
}

module.exports = { PrintService, findSoffice };
