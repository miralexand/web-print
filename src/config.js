'use strict';

const path = require('path');

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  port: int(process.env.PORT, 3000),
  authUser: process.env.AUTH_USER || 'admin',
  authPass: process.env.AUTH_PASS || 'admin123',
  sessionSecret: process.env.SESSION_SECRET || 'please-change-this-secret',
  hostPrintApi: (process.env.HOST_PRINT_API || 'http://host.docker.internal:8081').replace(/\/+$/, ''),
  hostPrintToken: process.env.HOST_PRINT_TOKEN || '',
  hostPrintTimeout: int(process.env.HOST_PRINT_TIMEOUT, 180000),
  tmpFolder: process.env.TMP_FOLDER || path.join(__dirname, '..', 'tmp'),
  logFolder: process.env.LOG_FOLDER || path.join(__dirname, '..', 'logs'),
  maxFileSize: int(process.env.MAX_FILE_SIZE, 20 * 1024 * 1024),
};
