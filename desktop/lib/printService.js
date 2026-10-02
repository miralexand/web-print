'use strict';

/**
 * 打包进 Electron 的本地打印服务核心（与 host-print-agent/agent.js 功能一致）。
 * - Office 转 PDF：优先 LibreOffice，其次 Microsoft Office / WPS 的 COM 自动化兜底
 * - 支持可配置的 URL 路径前缀（basePath），便于通过 Cloudflare 隧道以“域名 + 路径”暴露
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

// 通过 Office / WPS 的 COM 自动化转 PDF（Windows 专用）
// 注意：部分环境（如 WPS 接管）在关闭 COM 时会抛 RPC 错误，但 PDF 已生成，
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
try {
  if ($ext -eq '.xls' -or $ext -eq '.xlsx' -or $ext -eq '.csv') {
    $app = New-App @('Excel.Application','KET.Application')
    $app.Visible = $false; $app.DisplayAlerts = $false
    $wb = $app.Workbooks.Open($in, 0, $true)
    $wb.ExportAsFixedFormat(0, $out)
    Quiet { $wb.Close($false) }; Quiet { $app.Quit() }
  } elseif ($ext -eq '.ppt' -or $ext -eq '.pptx') {
    $app = New-App @('PowerPoint.Application','KWPP.Application')
    $pres = $app.Presentations.Open($in, $true, $false, $false)
    $pres.SaveAs($out, 32)
    Quiet { $pres.Close() }; Quiet { $app.Quit() }
  } else {
    $app = New-App @('Word.Application','KWPS.Application')
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

  sofficeFound() {
    if (!this.sofficePath || this.sofficePath === 'soffice') return false;
    try {
      return fs.existsSync(this.sofficePath);
    } catch (_) {
      return false;
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

  /** 用 LibreOffice 转换（独立用户配置目录 + 重试） */
  convertWithLibreOffice(filePath, expected) {
    const outDir = this.convertDir;
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
        throw new Error(result.output || (result.err && result.err.message) || 'LibreOffice 未生成 PDF');
      } finally {
        this.cleanup(profileDir);
      }
    })();
  }

  /** 用 Microsoft Office / WPS 的 COM 自动化转换 */
  convertWithCom(filePath, expected) {
    const ext = path.extname(filePath).toLowerCase();
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        return reject(new Error('COM 转换仅支持 Windows'));
      }
      const env = { ...process.env, CONV_IN: filePath, CONV_OUT: expected, CONV_EXT: ext };
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', COM_SCRIPT],
        { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.trim();
          // 只要 PDF 已生成即视为成功（忽略退出时的 RPC/关闭异常）
          if (fs.existsSync(expected)) return resolve(expected);
          return reject(new Error(output || (err && err.message) || 'Office/WPS 未生成 PDF'));
        }
      );
    });
  }

  /**
   * Office / 图片 → PDF：LibreOffice 优先，失败后用 Office/WPS COM 兜底。
   * 返回生成的 PDF 路径。
   */
  async convertToPdf(filePath) {
    fs.mkdirSync(this.convertDir, { recursive: true });
    const expected = path.join(this.convertDir, path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf');
    const errors = [];

    if (this.sofficeFound()) {
      try {
        return await this.convertWithLibreOffice(filePath, expected);
      } catch (err) {
        errors.push(`LibreOffice：${err.message}`);
      }
    } else {
      errors.push('LibreOffice：未检测到 soffice');
    }

    try {
      return await this.convertWithCom(filePath, expected);
    } catch (err) {
      errors.push(`Office/WPS：${err.message}`);
    }

    throw new Error(`文档转 PDF 失败。${errors.join('；')}。请安装 LibreOffice，或安装 Microsoft Office / WPS 后重试。`);
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
        soffice: this.sofficePath,
        sofficeFound: this.sofficeFound(),
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
        this.log(`LibreOffice：${this.sofficeFound() ? this.sofficePath : '未检测到，将使用 Office/WPS 转换'}`);
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
      sofficeFound: this.sofficeFound(),
    };
  }
}

module.exports = { PrintService, findSoffice, decodeFilename, normalizeBasePath };
