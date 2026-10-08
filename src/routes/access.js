'use strict';

const os = require('os');
const express = require('express');
const config = require('../config');
const qrcode = require('../services/qrcode');

const router = express.Router();

// 二维码内容上限：接入场景只需容纳 URL，1KB 足够，同时避免接口被当成任意数据编码器滥用
const MAX_QR_BYTES = 1024;
const ECC_LEVELS = new Set(['L', 'M']);

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 取当前请求的端口：优先 Host 头，其次 socket，最后回落到本机配置 */
function requestPort(req) {
  const host = req.get('host') || '';
  const m = /:(\d+)$/.exec(host);
  if (m) return Number.parseInt(m[1], 10);
  if (req.socket && req.socket.localPort) return req.socket.localPort;
  return config.port;
}

/** 当前请求的对外地址；app.js 已设置 trust proxy，隧道场景下能得到 https 与真实域名 */
function requestOrigin(req) {
  const host = req.get('host');
  if (host) return `${req.protocol}://${host}`;
  return `${req.protocol}://127.0.0.1:${requestPort(req)}`;
}

/**
 * 归一化对外公开地址：裸域名自动补全 https 并去掉末尾斜杠。
 * 客户端仅允许 HTTPS，命名隧道（固定域名）必须走 https，因此裸域名按 https 处理。
 */
function normalizePublicUrl(value) {
  let url = String(value == null ? '' : value).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

/** 本机所有非回环 IPv4 地址（供手机在同一局域网内扫码接入） */
function lanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

/**
 * 客户端接入信息：给出当前地址、隧道地址与（可选）局域网入口，供网页端展示二维码。
 * 无需登录，与 /health、/api/status 一致。
 *
 * 客户端已限制「仅允许 HTTPS 连接」，因此默认只返回 https 入口；
 * 隧道地址来自 config.publicUrl（桌面端在隧道启动后写入）。
 */
router.get('/access-info', (req, res) => {
  const port = requestPort(req);
  const origin = requestOrigin(req);
  const publicUrl = normalizePublicUrl(config.publicUrl);
  const httpsOnly = config.accessHttpsOnly !== false;
  const candidates = [];
  const seen = new Set();

  const push = (url, label, kind) => {
    if (!url || seen.has(url)) return;
    // 客户端只认 https，明文入口对手机没有意义，直接不展示
    if (httpsOnly && !/^https:\/\//i.test(url)) return;
    seen.add(url);
    candidates.push({ url, label, kind });
  };

  // 隧道地址排在最前：网页端默认选中它，手机扫码后即可直接使用
  push(publicUrl, '隧道地址（手机可直接访问）', 'tunnel');
  push(origin, '当前访问地址', 'current');
  for (const nic of lanIPv4()) {
    push(`http://${nic.address}:${port}`, `局域网 · ${nic.name} · ${nic.address}`, 'lan');
  }
  push(`http://127.0.0.1:${port}`, '本机（仅本机可访问）', 'loopback');

  res.json({
    origin,
    publicUrl,
    port,
    secure: req.protocol === 'https',
    httpsOnly,
    // 手机客户端 APK 下载地址（可在服务端用 APK_URL 覆盖）
    apkUrl: config.apkUrl || '',
    candidates,
    // 没有可用 https 入口时给网页端一句明确的指引
    hint: candidates.length
      ? ''
      : '当前没有可用的 HTTPS 地址。手机客户端仅允许通过 HTTPS 连接，请在「Cloudflare 隧道」页启动隧道，或设置 PUBLIC_URL 后再试。',
  });
});

/**
 * 二维码图片（SVG）。不传 data 时编码当前访问地址。
 * 供网页端「手机接入」卡片直接 <img> 引用，也便于其他客户端复用。
 */
router.get('/qrcode', (req, res) => {
  const raw = typeof req.query.data === 'string' ? req.query.data : '';
  // 未指定内容时优先用配置的对外地址：客户端只认 https，回退到请求自身可能得到明文地址
  const data = raw || normalizePublicUrl(config.publicUrl) || requestOrigin(req);

  if (Buffer.byteLength(data, 'utf8') > MAX_QR_BYTES) {
    return res.status(400).json({ error: `二维码内容过长（最大 ${MAX_QR_BYTES} 字节）` });
  }

  const ecc = ECC_LEVELS.has(req.query.ecc) ? req.query.ecc : 'M';
  const scale = clampInt(req.query.scale, 4, 1, 20);
  const margin = clampInt(req.query.margin, 4, 0, 16);

  try {
    const svg = qrcode.toSvg(data, { ecc, scale, margin });
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    // 地址可能随网络变化，不缓存避免展示过期入口
    res.set('Cache-Control', 'no-store');
    return res.send(svg);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
