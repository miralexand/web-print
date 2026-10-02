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

router.post('/print', upload.single('file'), (req, res) => {
  if (req.file && req.file.originalname) {
    req.file.originalname = decodeFilename(req.file.originalname);
  }
  const result = validateUpload(req.file, config.maxFileSize);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const quota = identity.quotaIdentity(req);
  const consumed = limiter.hit(quota.key, quota.limit, quota.windowHours);
  if (!consumed.allowed) {
    const waitMinutes = Math.max(1, Math.ceil((new Date(consumed.status.resetAt).getTime() - Date.now()) / 60000));
    return res.status(429).json({
      error: `已达到打印次数上限（每 ${quota.windowHours} 小时 ${quota.limit} 次），约 ${waitMinutes} 分钟后可再打印`,
      quota: consumed.status,
    });
  }

  fs.mkdirSync(config.tmpFolder, { recursive: true });
  const storedName = `${crypto.randomUUID()}${result.ext}`;
  const filePath = path.join(config.tmpFolder, storedName);
  fs.writeFileSync(filePath, req.file.buffer);

  const paperSize = PAPER_SIZES.has(req.body.paperSize) ? req.body.paperSize : 'A4';
  const owner = quota.owner;
  const task = queue.createTask({
    originalName: req.file.originalname,
    size: req.file.size,
    kind: result.kind,
    copies: toInt(req.body.copies, 1, 1, 99),
    pages: normalizePages(req.body.pages),
    color: req.body.color === 'color' ? 'color' : 'mono',
    paperSize,
    printer: (req.body.printer || '').toString().trim().slice(0, 120),
    ownerType: owner.type,
    ownerId: owner.id,
    ownerIp: owner.ip,
    ownerName: owner.name,
    _filePath: filePath,
    _quotaKey: consumed.token ? quota.key : null,
    _quotaToken: consumed.token,
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
