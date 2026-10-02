'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.mkdirSync(config.logFolder, { recursive: true });
    fs.appendFileSync(path.join(config.logFolder, 'app.log'), line + '\n', 'utf8');
  } catch (_) {
    /* 日志写入失败不影响主流程 */
  }
}

module.exports = {
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message, err) => write('error', err ? `${message} ${err.stack || err.message || err}` : message),
};
