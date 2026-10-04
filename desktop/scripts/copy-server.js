'use strict';

/** 将仓库根目录的 Web 服务（src/）复制进 Electron 应用，实现一体化的本地运行 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const source = path.join(repoRoot, 'src');
const dest = path.join(__dirname, '..', 'server');

if (!fs.existsSync(source)) {
  console.error(`未找到 Web 服务源码：${source}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(source, dest, { recursive: true });
console.log('Web 服务已复制到 desktop/server');
