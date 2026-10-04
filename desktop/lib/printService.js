'use strict';

/**
 * 打包进 Electron 的本地打印服务核心。
 * - 文档转 PDF：默认使用 WPS 的 COM 转换（KWPS/KET/KWPP），失败后自动切换到 Microsoft Office（Word/Excel/PowerPoint）
 * - 支持可配置的 URL 路径前缀（basePath），便于通过 Cloudflare 隧道以“域名 + 路径”暴露
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { print, getPrinters } = require('pdf-to-printer');

function normalizeBasePath(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}

/** 修复 multipart 文件名乱码（busboy 默认 latin1 解析） */
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

function normalizePages(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, '');
  if (!s) return '';
  return /^[0-9,-]{1,100}$/.test(s) ? s : '';
}

// 通过 WPS / Microsoft Office 的 COM 自动化转 PDF（Windows 专用）。
// 通过环境变量 CONV_SUITE 选择套件：wps 或 office。
// 注意：部分环境在关闭 COM 时会抛 RPC 错误，但 PDF 已生成，
// 因此以“输出文件是否存在”为成功判据，忽略 Quit/Close 的异常。
const COM_SCRIPT = `
$ErrorActionPreference = 'Stop'
function New-App([string[]]$names) {
  foreach ($n in $names) { try { return New-Object -ComObject $n } catch { } }
  throw ("no COM app: " + ($names -join ', '))
}
function Quiet([scriptblock]$block) { try { & $block } catch { } }
$in = $env:CONV_IN
$out = $env:CONV_OUT
$ext = $env:CONV_EXT
if ($env:CONV_SUITE -eq 'wps') {
  $word = @('KWPS.Application'); $excel = @('KET.Application'); $ppt = @('KWPP.Application')
} else {
  $word = @('Word.Application'); $excel = @('Excel.Application'); $ppt = @('PowerPoint.Application')
}
try {
  if ($ext -eq '.xls' -or $ext -eq '.xlsx' -or $ext -eq '.csv') {
    $app = New-App $excel
    $app.Visible = $false; $app.DisplayAlerts = $false
    $wb = $app.Workbooks.Open($in, 0, $true)
    $wb.ExportAsFixedFormat(0, $out)
    Quiet { $wb.Close($false) }; Quiet { $app.Quit() }
  } elseif ($ext -eq '.ppt' -or $ext -eq '.pptx') {
    $app = New-App $ppt
    $pres = $app.Presentations.Open($in, $true, $false, $false)
    $pres.SaveAs($out, 32)
    Quiet { $pres.Close() }; Quiet { $app.Quit() }
  } else {
    $app = New-App $word
    $app.Visible = $false; $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($in, $false, $true)
    $doc.ExportAsFixedFormat($out, 17)
    Quiet { $doc.Close($false) }; Quiet { $app.Quit() }
  }
} catch {
  if (-not (Test-Path $out)) { Write-Error $_; exit 1 }
}
if (Test-Path $out) { exit 0 } else { Write-Error 'no output'; exit 1 }
`;

class PrintService {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number.parseInt(options.port, 10) || 8081;
    this.token = options.token || '';
    this.basePath = normalizeBasePath(options.basePath);
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

  /** 用指定套件（wps / office）的 COM 转换 */
  convertWithCom(filePath, expected, suite) {
    const ext = path.extname(filePath).toLowerCase();
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        return reject(new Error('COM 转换仅支持 Windows'));
      }
      const env = {
        ...process.env,
        CONV_IN: filePath,
        CONV_OUT: expected,
        CONV_EXT: ext,
        CONV_SUITE: suite,
      };
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', COM_SCRIPT],
        { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.trim();
          // 只要 PDF 已生成即视为成功（忽略退出时的 RPC/关闭异常）
          if (fs.existsSync(expected)) return resolve(expected);
          return reject(new Error(output || (err && err.message) || '未生成 PDF'));
        }
      );
    });
  }

  /**
   * 文档 → PDF：默认 WPS，失败后切换 Microsoft Office。
   * 返回生成的 PDF 路径。
   */
  async convertToPdf(filePath) {
    fs.mkdirSync(this.convertDir, { recursive: true });
    const expected = path.join(this.convertDir, path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf');
    const errors = [];
    for (const suite of ['wps', 'office']) {
      const label = suite === 'wps' ? 'WPS' : 'Microsoft Office';
      try {
        const out = await this.convertWithCom(filePath, expected, suite);
        if (fs.existsSync(out)) return out;
        errors.push(`${label}：未生成 PDF`);
      } catch (err) {
        errors.push(`${label}：${err.message}`);
      }
    }
    throw new Error(`文档转 PDF 失败（已尝试 WPS、Microsoft Office）。${errors.join('；')}。请安装 WPS 或 Microsoft Office 后重试。`);
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
      res.json({
        ok: true,
        service: 'web-print-agent',
        basePath: this.basePath,
        convertOrder: 'WPS → Microsoft Office',
        printers: printerCount,
      });
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
      const pages = normalizePages(req.body.pages);
      const color = req.body.color === 'color' ? 'color' : 'mono';
      const paperSize = (req.body.paperSize || '').trim();
      const printer = (req.body.printer || '').trim();
      const jobId = (req.body.jobId || '').trim();
      try {
        if (ext && ext !== '.pdf') {
          this.log(`任务 ${jobId}: 转换 ${ext} -> PDF（WPS 优先 / Office 兜底）`);
          convertedPath = await this.convertToPdf(uploadedPath);
          pdfPath = convertedPath;
        }
        const options = { copies };
        if (pages) options.pages = pages;
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
    if (this.basePath) app.use(this.basePath, router);
    app.use('/', router);
    app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));
    return app;
  }

  start() {
    if (this.running) return Promise.resolve(this.status());
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.convertDir, { recursive: true });
    const app = this.buildApp();
    return new Promise((resolve, reject) => {
      const server = app.listen(this.port, this.host, () => {
        this.server = server;
        this.running = true;
        this.log(`打印服务已启动：http://${this.host}:${this.port}${this.basePath}`);
        this.log('文档转换：优先 WPS COM，失败后切换 Microsoft Office COM');
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
    };
  }
}

module.exports = { PrintService, decodeFilename, normalizeBasePath, normalizePages };
