'use strict';

const path = require('path');

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  port: int(process.env.PORT, 3000),
  // 反向代理层数：本机直连可设为 0，Cloudflare Tunnel 场景保持 1
  trustProxy: process.env.TRUST_PROXY === undefined ? 1 : num(process.env.TRUST_PROXY, 1),

  // 初始管理员账号：仅在用户库为空时用于初始化
  bootstrapUser: process.env.AUTH_USER || 'admin',
  bootstrapPass: process.env.AUTH_PASS || 'admin123',

  sessionSecret: process.env.SESSION_SECRET || 'please-change-this-secret',
  sessionHours: num(process.env.SESSION_HOURS, 12),

  // 登录爆破防护
  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 10),
  loginWindowMinutes: num(process.env.LOGIN_WINDOW_MINUTES, 15),

  // 未登录（游客）打印配额：每 anonWindowHours 小时最多 anonPrintLimit 次
  anonPrintLimit: int(process.env.ANON_PRINT_LIMIT, 5),
  anonWindowHours: num(process.env.ANON_WINDOW_HOURS, 3),

  hostPrintApi: (process.env.HOST_PRINT_API || 'http://host.docker.internal:8081').replace(/\/+$/, ''),
  hostPrintToken: process.env.HOST_PRINT_TOKEN || '',
  hostPrintTimeout: int(process.env.HOST_PRINT_TIMEOUT, 180000),

  tmpFolder: process.env.TMP_FOLDER || path.join(__dirname, '..', 'tmp'),
  logFolder: process.env.LOG_FOLDER || path.join(__dirname, '..', 'logs'),
  dataFolder: process.env.DATA_FOLDER || path.join(__dirname, '..', 'data'),

  maxFileSize: int(process.env.MAX_FILE_SIZE, 20 * 1024 * 1024),
};
