'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const queue = require('../services/queue');
const hostPrint = require('../services/hostPrint');
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

router.post('/print', upload.single('file'), (req, res) => {
  const result = validateUpload(req.file, config.maxFileSize);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  fs.mkdirSync(config.tmpFolder, { recursive: true });
  const storedName = `${crypto.randomUUID()}${result.ext}`;
  const filePath = path.join(config.tmpFolder, storedName);
  fs.writeFileSync(filePath, req.file.buffer);

  const paperSize = PAPER_SIZES.has(req.body.paperSize) ? req.body.paperSize : 'A4';
  const task = queue.createTask({
    originalName: req.file.originalname,
    size: req.file.size,
    kind: result.kind,
    copies: toInt(req.body.copies, 1, 1, 99),
    color: req.body.color === 'color' ? 'color' : 'mono',
    paperSize,
    printer: (req.body.printer || '').toString().trim().slice(0, 120),
    _filePath: filePath,
  });

  return res.status(201).json({ task: queue.publicTask(task) });
});

router.get('/tasks', (req, res) => {
  res.json({ tasks: queue.listTasks() });
});

router.get('/tasks/:id', (req, res) => {
  const task = queue.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  return res.json({ task });
});

router.delete('/tasks/:id', (req, res) => {
  const result = queue.cancelTask(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ task: result.task });
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
