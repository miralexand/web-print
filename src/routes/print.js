'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const queue = require('../services/queue');
const hostPrint = require('../services/hostPrint');
const limiter = require('../services/usageLimiter');
const identity = require('../services/identity');
const { validateUpload } = require('../services/fileValidator');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize, files: 1 },
});

const PAPER_SIZES = new Set(['A3', 'A4', 'A5', 'B5', 'Letter', 'Legal']);

// 文本打印：上限 100KB（约 3 万字），避免一次提交超长内容阻塞队列
const MAX_TEXT_BYTES = 100 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 页码范围：仅允许数字、逗号、连字符，如 "1-3,5"；空表示全部 */
function normalizePages(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, '');
  if (!s) return '';
  if (!/^[0-9,-]{1,100}$/.test(s)) return '';
  return s;
}

function currentQuota(req) {
  const q = identity.quotaIdentity(req);
  return { ...limiter.status(q.key, q.limit, q.windowHours), key: q.key, limit: q.limit, windowHours: q.windowHours };
}

/**
 * 检查并消耗一次配额。超限时直接响应 429 并返回 null。
 * 文件打印与文本打印共用，避免出现两套配额/退还实现。
 */
function takeQuota(req, res) {
  const quota = identity.quotaIdentity(req);
  const consumed = limiter.hit(quota.key, quota.limit, quota.windowHours);
  if (!consumed.allowed) {
    const waitMinutes = Math.max(1, Math.ceil((new Date(consumed.status.resetAt).getTime() - Date.now()) / 60000));
    res.status(429).json({
      error: `已达到打印次数上限（每 ${quota.windowHours} 小时 ${quota.limit} 次），约 ${waitMinutes} 分钟后可再打印`,
      quota: consumed.status,
    });
    return null;
  }
  return { quota, consumed };
}

/**
 * 公共入队逻辑：把待打印内容落盘并创建任务。文件打印与文本打印共用。
 * @param {{buffer:Buffer, originalName:string, ext:string, kind:string,
 *          fields:object, quota:object, consumed:object}} input
 */
function enqueueTask(input) {
  const { buffer, originalName, ext, kind, fields, quota, consumed } = input;
  fs.mkdirSync(config.tmpFolder, { recursive: true });
  const filePath = path.join(config.tmpFolder, `${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buffer);

  const owner = quota.owner;
  return queue.createTask({
    originalName,
    size: buffer.length,
    kind,
    copies: toInt(fields.copies, 1, 1, 99),
    pages: normalizePages(fields.pages),
    color: fields.color === 'color' ? 'color' : 'mono',
    paperSize: PAPER_SIZES.has(fields.paperSize) ? fields.paperSize : 'A4',
    orientation: fields.orientation === 'landscape' ? 'landscape' : 'portrait',
    printer: (fields.printer || '').toString().trim().slice(0, 120),
    ownerType: owner.type,
    ownerId: owner.id,
    ownerIp: owner.ip,
    ownerName: owner.name,
    _filePath: filePath,
    _quotaKey: consumed.token ? quota.key : null,
    _quotaToken: consumed.token,
  });
}

/** 文本打印的文件名（带时间戳，便于在任务列表中区分） */
function textFileName(date) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `文本打印-${stamp}.txt`;
}

router.post('/print', upload.single('file'), (req, res) => {
  if (req.file && req.file.originalname) {
    req.file.originalname = decodeFilename(req.file.originalname);
  }
  const result = validateUpload(req.file, config.maxFileSize);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const taken = takeQuota(req, res);
  if (!taken) return undefined;

  const task = enqueueTask({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    ext: result.ext,
    kind: result.kind,
    fields: req.body,
    quota: taken.quota,
    consumed: taken.consumed,
  });

  return res.status(201).json({ task: queue.publicTask(task), quota: currentQuota(req) });
});

/**
 * 文本打印：接收纯文本，落盘为 UTF-8(.txt) 后复用既有队列与打印链路。
 * 打印主机侧由 Word/WPS 的 COM 转换把 .txt 转成 PDF 再送打印机。
 */
router.post('/print/text', (req, res) => {
  const body = req.body || {};
  const raw = typeof body.content === 'string' ? body.content : '';
  // 统一换行，避免 CRLF/LF 混用导致 Word 分页异常
  const content = raw.replace(/\r\n?/g, '\n');

  if (!content.trim()) {
    return res.status(400).json({ error: '打印内容不能为空' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    return res.status(400).json({ error: `文本过长（最大 ${Math.round(MAX_TEXT_BYTES / 1024)}KB）` });
  }

  const taken = takeQuota(req, res);
  if (!taken) return undefined;

  // 必须带 UTF-8 BOM：Word/WPS 在未显式指定编码时按系统 ANSI 代码页解码，
  // 无 BOM 的 UTF-8 中文会变成乱码。BOM 让编码无可歧义。
  const buffer = Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')]);

  const task = enqueueTask({
    buffer,
    originalName: textFileName(new Date()),
    ext: '.txt',
    kind: 'text',
    fields: body,
    quota: taken.quota,
    consumed: taken.consumed,
  });

  return res.status(201).json({ task: queue.publicTask(task), quota: currentQuota(req) });
});

router.get('/tasks', (req, res) => {
  const tasks = queue.listTasks().filter((task) => identity.canAccess(req, task));
  res.json({ tasks, quota: currentQuota(req) });
});

router.get('/tasks/:id', (req, res) => {
  const task = queue.getTask(req.params.id);
  if (!task || !identity.canAccess(req, task)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  return res.json({ task, quota: currentQuota(req) });
});

router.delete('/tasks/:id', (req, res) => {
  const task = queue.getTask(req.params.id);
  if (!task || !identity.canAccess(req, task)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  const result = queue.removeTask(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true, quota: currentQuota(req) });
});

router.get('/printers', async (req, res) => {
  try {
    const data = await hostPrint.listPrinters();
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message, printers: [] });
  }
});

router.get('/status', async (req, res) => {
  const online = await hostPrint.ping();
  res.json({ hostPrintAgent: online ? 'online' : 'offline' });
});

module.exports = router;
