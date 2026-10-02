'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');

const router = express.Router();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username && password && safeEqual(username, config.authUser) && safeEqual(password, config.authPass)) {
    req.session.user = { username };
    return res.json({ user: { username } });
  }
  return res.status(401).json({ error: '账号或密码错误' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  return res.status(401).json({ error: '未登录' });
});

module.exports = router;
