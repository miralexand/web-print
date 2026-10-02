'use strict';

const config = require('../config');

/**
 * 解析请求身份。
 * - 已登录：type=user，携带用户 id 与用户名
 * - 未登录：type=anon，以客户端 IP 作为配额主体
 */
function forRequest(req) {
  if (req.user) {
    return { type: 'user', id: req.user.id, ip: req.ip, name: req.user.username };
  }
  return { type: 'anon', id: null, ip: req.ip, name: '游客' };
}

/**
 * 返回用于配额判断的 key、限额与窗口。
 * 用户 printQuota=0 表示不限次数。
 */
function quotaIdentity(req) {
  if (req.user) {
    return {
      key: `user:${req.user.id}`,
      limit: req.user.printQuota,
      windowHours: req.user.quotaWindowHours,
      owner: forRequest(req),
    };
  }
  return {
    key: `anon:${req.ip}`,
    limit: config.anonPrintLimit,
    windowHours: config.anonWindowHours,
    owner: forRequest(req),
  };
}

/** 判断某任务是否对该请求可见 */
function canAccess(req, task) {
  if (req.user && req.user.role === 'admin') return true;
  if (req.user && task.ownerType === 'user' && task.ownerId === req.user.id) return true;
  if (!req.user && task.ownerType === 'anon' && task.ownerIp === req.ip) return true;
  return false;
}

module.exports = { forRequest, quotaIdentity, canAccess };
