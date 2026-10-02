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

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function currentQuota(req) {
  const q = identity.quotaIdentity(req);
  return { ...limiter.status(q.key, q.limit, q.windowHours), key: q.key, limit: q.limit, windowHours: q.windowHours };
}

router.post('/print', upload.single('file'), (req, res) => {
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
  const result = queue.cancelTask(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ task: result.task, quota: currentQuota(req) });
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
