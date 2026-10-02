'use strict';

const express = require('express');
const config = require('../config');
const userStore = require('../services/userStore');
const limiter = require('../services/usageLimiter');
const identity = require('../services/identity');

const router = express.Router();

function loginKey(req) {
  return `login:${req.ip}`;
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = loginKey(req);

  const attempts = limiter.status(key, config.loginMaxAttempts, config.loginWindowMinutes / 60);
  if (!attempts.unlimited && !attempts.allowed) {
    return res.status(429).json({
      error: `尝试过于频繁，请于 ${new Date(attempts.resetAt).toLocaleTimeString('zh-CN')} 后重试`,
    });
  }

  const user = userStore.findByUsername(username);
  const valid = user && user.enabled !== false && userStore.verifyPassword(String(password || ''), user.passwordHash);
  if (!valid) {
    limiter.hit(key, config.loginMaxAttempts, config.loginWindowMinutes / 60);
    return res.status(401).json({ error: '账号或密码错误' });
  }

  limiter.reset(key);
  return req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '登录失败，请重试' });
    req.session.userId = user.id;
    userStore.touchLogin(user.id);
    return res.json({ user: userStore.publicUser(user) });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const quota = identity.quotaIdentity(req);
  res.json({
    user: req.user || null,
    anonymous: !req.user,
    quota: limiter.status(quota.key, quota.limit, quota.windowHours),
  });
});

module.exports = router;
