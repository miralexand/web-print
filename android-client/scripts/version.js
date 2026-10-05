'use strict';

/**
 * 版本号推导：versionName -> versionCode
 *
 * 约定：
 *   - versionName 原样保留（允许 `2.2.0-beta`、`2.2` 这类写法）
 *   - versionCode 取数字部分，按 major*10000 + minor*100 + patch 计算，
 *     例如 2.1.2 -> 20102，随版本单调递增
 *
 * 用法：
 *   node scripts/version.js 2.2.0          # 打印 name=... / code=...（可直接 >> $GITHUB_OUTPUT）
 *   node scripts/version.js 2.2.0 --code   # 只打印 versionCode
 *   node scripts/version.js 2.2.0 --name   # 只打印 versionName
 *
 * 解析失败时以非零退出码结束，便于 CI 直接中断。
 */

/**
 * @param {string} input 版本名，可带 v 前缀与 -beta 之类的预发布后缀
 * @returns {{name: string, code: number}}
 */
function parseVersion(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('版本号为空');

  const withoutV = raw.replace(/^v/i, '');
  // versionCode 只看数字部分，预发布后缀忽略（2.2.0-beta 与 2.2.0 得到同一个 code）
  const numeric = withoutV.split('-')[0];
  if (!/^[0-9]/.test(numeric)) throw new Error(`版本号必须以数字开头：${raw}`);

  const segments = numeric.split('.');
  const nums = [0, 1, 2].map((i) => {
    const digits = String(segments[i] == null ? '' : segments[i]).replace(/[^0-9]/g, '');
    return digits === '' ? 0 : Number.parseInt(digits, 10);
  });
  const [major, minor, patch] = nums;

  if (major > 200 || minor > 99 || patch > 99) {
    throw new Error(`版本段超出约定范围（major<=200, minor<=99, patch<=99）：${raw}`);
  }
  return { name: withoutV, code: major * 10000 + minor * 100 + patch };
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const mode = args.find((a) => a.startsWith('--')) || '';

  const { name, code } = parseVersion(input);
  if (mode === '--code') {
    process.stdout.write(String(code));
  } else if (mode === '--name') {
    process.stdout.write(name);
  } else {
    process.stdout.write(`name=${name}\ncode=${code}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`版本号解析失败：${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseVersion };
