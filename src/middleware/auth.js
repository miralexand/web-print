'use strict';

const userStore = require('../services/userStore');

/** 将会话中的用户加载到 req.user；用户被禁用或删除时自动失效 */
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = userStore.findById(req.session.userId);
    if (user && user.enabled !== false) {
      req.user = userStore.publicUser(user);
    } else {
      req.session.userId = null;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: '未登录或登录已过期' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: '需要管理员权限' });
}

module.exports = { attachUser, requireAuth, requireAdmin };
