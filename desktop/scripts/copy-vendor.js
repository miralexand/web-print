'use strict';

/** 从 node_modules 复制 Vue / Element Plus 的 UMD 资源到 renderer/vendor */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');

const files = [
  ['vue/dist/vue.global.prod.js', 'vue.global.prod.js'],
  ['element-plus/dist/index.full.min.js', 'element-plus.full.min.js'],
  ['element-plus/dist/index.css', 'element-plus.css'],
];

fs.mkdirSync(vendor, { recursive: true });
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, 'node_modules', from), path.join(vendor, to));
}
console.log('vendor 资源已复制到 renderer/vendor');
