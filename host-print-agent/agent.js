'use strict';

/**
 * Windows 宿主机打印 Agent（命令行版）
 * ------------------------------------------------------------
 *  1. 接收 Web 服务 POST 过来的待打印文件
 *  2. Office / 图片转 PDF：优先 LibreOffice，其次 Microsoft Office / WPS 的 COM 自动化
 *  3. 用 pdf-to-printer 调用 Windows 打印驱动，提交到指定 / 默认打印机
 *
 * 默认仅监听 127.0.0.1。若需通过 Cloudflare 隧道以“域名 + 路径”暴露，
 * 可设置 AGENT_BASE_PATH=/agent，并务必设置 AGENT_TOKEN 做鉴权。
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
const BASE_PATH = normalizeBasePath(process.env.AGENT_BASE_PATH || '');
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'webprint-agent');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const CONVERT_DIR = path.join(WORK_DIR, 'converted');
const SOFFICE = process.env.SOFFICE_PATH || findSoffice();
const SOFFICE_FOUND = SOFFICE !== 'soffice' && fs.existsSync(SOFFICE);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CONVERT_DIR, { recursive: true });

function normalizeBasePath(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice 7\\program\\soffice.exe',
    'C:\\Program Files\\LibreOffice 6\\program\\soffice.exe',
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

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function cleanup(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

function latestPdf(dir) {
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

function convertWithLibreOffice(filePath, expected) {
  const profileDir = path.join(WORK_DIR, `lo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const profileUri = `file:///${profileDir.replace(/\\/g, '/')}`;
  const args = [
    '--headless', '--nologo', '--nofirststartwizard', '--norestore', '--invisible',
    `-env:UserInstallation=${profileUri}`,
    '--convert-to', 'pdf', '--outdir', CONVERT_DIR, filePath,
  ];
  const runOnce = () => new Promise((resolve) => {
    execFile(SOFFICE, args, { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      const found = latestPdf(CONVERT_DIR);
      if (found) return found;
      throw new Error(result.output || (result.err && result.err.message) || 'LibreOffice 未生成 PDF');
    } finally {
      cleanup(profileDir);
    }
  })();
}

function convertWithCom(filePath, expected) {
  const ext = path.extname(filePath).toLowerCase();
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('COM 转换仅支持 Windows'));
    const env = { ...process.env, CONV_IN: filePath, CONV_OUT: expected, CONV_EXT: ext };
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', COM_SCRIPT],
      { timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (fs.existsSync(expected)) return resolve(expected);
        return reject(new Error(output || (err && err.message) || 'Office/WPS 未生成 PDF'));
      }
    );
  });
}

async function convertToPdf(filePath) {
  fs.mkdirSync(CONVERT_DIR, { recursive: true });
  const expected = path.join(CONVERT_DIR, path.basename(filePath).replace(/\.[^.]+$/, '') + '.pdf');
  const errors = [];
  if (SOFFICE_FOUND) {
    try {
      return await convertWithLibreOffice(filePath, expected);
    } catch (err) {
      errors.push(`LibreOffice：${err.message}`);
    }
  } else {
    errors.push('LibreOffice：未检测到 soffice');
  }
  try {
    return await convertWithCom(filePath, expected);
  } catch (err) {
    errors.push(`Office/WPS：${err.message}`);
  }
  throw new Error(`文档转 PDF 失败。${errors.join('；')}。请安装 LibreOffice，或安装 Microsoft Office / WPS 后重试。`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname) || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

const router = express.Router();

router.use((req, res, next) => {
  if (TOKEN && req.get('x-print-token') !== TOKEN) {
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
  res.json({ ok: true, service: 'web-print-agent', basePath: BASE_PATH, soffice: SOFFICE, sofficeFound: SOFFICE_FOUND, printers: printerCount });
});

router.get('/printers', async (req, res) => {
  try {
    res.json({ printers: await getPrinters() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, printers: [] });
  }
});

router.post('/print', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '未接收到文件' });
  }

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

const app = express();
app.disable('x-powered-by');
if (BASE_PATH) app.use(BASE_PATH, router);
app.use('/', router);
app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));

app.listen(PORT, HOST, () => {
  log(`打印 Agent 已启动：http://${HOST}:${PORT}${BASE_PATH}`);
  log(`LibreOffice：${SOFFICE_FOUND ? SOFFICE : '未检测到，将使用 Office/WPS 转换'}`);
  if (!TOKEN) {
    log('提示：未设置 AGENT_TOKEN，接口未启用令牌校验（仅本机访问风险可控；若通过公网暴露请务必设置）');
  }
});
