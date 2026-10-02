'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

// key -> [{ t: 时间戳(ms), id: 唯一令牌 }]
let usage = Object.create(null);
let saveTimer = null;

const file = () => path.join(config.dataFolder, 'usage.json');

function saveNow() {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, usage }, null, 2), 'utf8');
    fs.renameSync(tmp, file());
  } catch (err) {
    logger.error('保存用量数据失败', err);
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function flush() {
  clearTimeout(saveTimer);
  saveNow();
}

function load() {
  usage = Object.create(null);
  try {
    if (fs.existsSync(file())) {
      const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (parsed && parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
    }
  } catch (err) {
    logger.error('加载用量数据失败，将以空记录启动', err);
    usage = Object.create(null);
  }
}

function windowMs(hours) {
  return Math.max(hours, 1 / 60) * 60 * 60 * 1000;
}

function prune(key, ms, nowMs) {
  const list = (usage[key] || []).filter((e) => nowMs - e.t < ms);
  if (list.length) usage[key] = list;
  else delete usage[key];
  return list;
}

function status(key, limit, hours) {
  if (!limit || limit <= 0) return { unlimited: true };
  const ms = windowMs(hours);
  const nowMs = Date.now();
  const list = prune(key, ms, nowMs);
  const used = list.length;
  const remaining = Math.max(0, limit - used);
  const oldest = list.length ? Math.min(...list.map((e) => e.t)) : nowMs;
  return {
    limit,
    used,
    remaining,
    allowed: remaining > 0,
    windowHours: hours,
    resetAt: new Date(oldest + ms).toISOString(),
  };
}

/**
 * 尝试消耗一次配额。返回 { allowed, token, status }。
 * allowed 为 false 时不消耗；成功时 token 可用于 refund 退还。
 */
function hit(key, limit, hours) {
  const current = status(key, limit, hours);
  if (current.unlimited) return { allowed: true, unlimited: true, token: null, status: current };
  if (!current.allowed) return { allowed: false, token: null, status: current };
  const token = crypto.randomBytes(8).toString('hex');
  (usage[key] = usage[key] || []).push({ t: Date.now(), id: token });
  save();
  return { allowed: true, token, status: status(key, limit, hours) };
}

function refund(key, token) {
  if (!key || !token || !usage[key]) return;
  const before = usage[key].length;
  usage[key] = usage[key].filter((e) => e.id !== token);
  if (!usage[key].length) delete usage[key];
  if (usage[key] && usage[key].length !== before) save();
  else if (!usage[key]) save();
}

function reset(key) {
  if (usage[key]) {
    delete usage[key];
    save();
  }
}

function snapshot() {
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const rows = [];
  for (const key of Object.keys(usage)) {
    const list = (usage[key] || []).filter((e) => nowMs - e.t < dayMs * 30);
    if (!list.length) {
      delete usage[key];
      continue;
    }
    rows.push({
      key,
      count: list.length,
      last: new Date(Math.max(...list.map((e) => e.t))).toISOString(),
    });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

module.exports = { load, flush, status, hit, refund, reset, snapshot };
