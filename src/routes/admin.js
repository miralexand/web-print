'use strict';

const express = require('express');
const config = require('../config');
const userStore = require('../services/userStore');
const limiter = require('../services/usageLimiter');

const router = express.Router();

router.get('/users', (req, res) => {
  res.json({ users: userStore.list() });
});

router.post('/users', (req, res) => {
  try {
    const user = userStore.create({ ...req.body, createdBy: req.user.username });
    return res.status(201).json({ user });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

router.patch('/users/:id', (req, res) => {
  try {
    const user = userStore.update(req.params.id, req.body || {});
    return res.json({ user });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/users/:id', (req, res) => {
  try {
    userStore.remove(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/usage', (req, res) => {
  res.json({
    anonymous: { limit: config.anonPrintLimit, windowHours: config.anonWindowHours },
    usage: limiter.snapshot(),
  });
});

router.post('/usage/reset', (req, res) => {
  const key = req.body && req.body.key;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: '缺少要重置的 key' });
  limiter.reset(key);
  return res.json({ ok: true });
});

module.exports = router;
