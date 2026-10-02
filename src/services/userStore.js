'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

const ROLES = ['admin', 'user'];
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 6;
const MAX_QUOTA = 100000;
const MAX_WINDOW_HOURS = 24 * 30;

let users = [];

const file = () => path.join(config.dataFolder, 'users.json');
const now = () => new Date().toISOString();

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function normalizeQuota(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw httpError('打印配额需为不小于 0 的整数（0 表示不限）');
  return Math.min(n, MAX_QUOTA);
}

function normalizeWindow(value) {
  if (value === undefined || value === null || value === '') return config.anonWindowHours;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_WINDOW_HOURS) {
    throw httpError(`配额窗口需在 0-${MAX_WINDOW_HOURS} 小时之间`);
  }
  return n;
}

function save() {
  fs.mkdirSync(config.dataFolder, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), 'utf8');
  fs.renameSync(tmp, file());
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled !== false,
    printQuota: user.printQuota || 0,
    quotaWindowHours: user.quotaWindowHours || config.anonWindowHours,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null,
    createdBy: user.createdBy || 'system',
  };
}

function makeUser({ username, password, role, enabled, printQuota, quotaWindowHours, createdBy }) {
  return {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role,
    enabled: enabled !== false,
    printQuota: printQuota || 0,
    quotaWindowHours: quotaWindowHours || config.anonWindowHours,
    createdAt: now(),
    updatedAt: now(),
    createdBy: createdBy || 'system',
    lastLoginAt: null,
  };
}

function ensureAdmin() {
  if (users.some((u) => u.role === 'admin' && u.enabled !== false)) return;
  let username = config.bootstrapUser;
  if (users.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) {
    username = `admin_${Date.now()}`;
  }
  const admin = makeUser({
    username,
    password: config.bootstrapPass,
    role: 'admin',
    createdBy: 'bootstrap',
  });
  users.push(admin);
  save();
  logger.info(`已创建初始管理员账号「${admin.username}」，请登录后尽快修改密码`);
}

function load() {
  users = [];
  try {
    if (fs.existsSync(file())) {
      const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (parsed && Array.isArray(parsed.users)) users = parsed.users;
    }
  } catch (err) {
    logger.error('加载用户数据失败，将以空库启动', err);
    users = [];
  }
  ensureAdmin();
}

function list() {
  return users.map(publicUser);
}

function findById(id) {
  return users.find((u) => u.id === id) || null;
}

function findByUsername(name) {
  const target = String(name || '').trim().toLowerCase();
  return users.find((u) => String(u.username).toLowerCase() === target) || null;
}

function enabledAdminCount() {
  return users.filter((u) => u.role === 'admin' && u.enabled !== false).length;
}

function create(input) {
  const username = String(input.username || '').trim();
  if (!USERNAME_RE.test(username)) {
    throw httpError('用户名需为 3-32 位字母、数字、下划线、点或连字符');
  }
  if (String(input.password || '').length < MIN_PASSWORD) {
    throw httpError(`密码至少 ${MIN_PASSWORD} 位`);
  }
  if (findByUsername(username)) throw httpError('用户名已存在');
  const role = input.role || 'user';
  if (!ROLES.includes(role)) throw httpError('角色只能是 admin 或 user');
  const user = makeUser({
    username,
    password: String(input.password),
    role,
    enabled: input.enabled !== false,
    printQuota: normalizeQuota(input.printQuota),
    quotaWindowHours: normalizeWindow(input.quotaWindowHours),
    createdBy: input.createdBy,
  });
  users.push(user);
  save();
  return publicUser(user);
}

function update(id, patch) {
  const user = findById(id);
  if (!user) throw httpError('用户不存在', 404);

  // 先在副本上应用变更，全部校验通过后再提交，避免半更新状态
  const next = { ...user };

  if (patch.username !== undefined) {
    const username = String(patch.username).trim();
    if (!USERNAME_RE.test(username)) {
      throw httpError('用户名需为 3-32 位字母、数字、下划线、点或连字符');
    }
    const dup = findByUsername(username);
    if (dup && dup.id !== id) throw httpError('用户名已存在');
    next.username = username;
  }
  if (patch.password !== undefined && patch.password !== '') {
    if (String(patch.password).length < MIN_PASSWORD) throw httpError(`密码至少 ${MIN_PASSWORD} 位`);
    next.passwordHash = hashPassword(String(patch.password));
  }
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw httpError('角色只能是 admin 或 user');
    next.role = patch.role;
  }
  if (patch.enabled !== undefined) {
    next.enabled = !!patch.enabled;
  }
  if (patch.printQuota !== undefined) {
    next.printQuota = normalizeQuota(patch.printQuota);
  }
  if (patch.quotaWindowHours !== undefined) {
    next.quotaWindowHours = normalizeWindow(patch.quotaWindowHours);
  }

  const hasEnabledAdmin = users.some((u) => {
    const candidate = u.id === id ? next : u;
    return candidate.role === 'admin' && candidate.enabled !== false;
  });
  if (!hasEnabledAdmin) {
    throw httpError('系统至少需要保留一名启用状态的管理员');
  }

  Object.assign(user, next, { updatedAt: now() });
  save();
  return publicUser(user);
}

function remove(id) {
  const user = findById(id);
  if (!user) throw httpError('用户不存在', 404);
  if (user.role === 'admin' && user.enabled !== false && enabledAdminCount() <= 1) {
    throw httpError('不能删除最后一名启用状态的管理员');
  }
  users = users.filter((u) => u.id !== id);
  save();
}

function touchLogin(id) {
  const user = findById(id);
  if (!user) return;
  user.lastLoginAt = now();
  save();
}

module.exports = {
  ROLES,
  MIN_PASSWORD,
  load,
  list,
  findById,
  findByUsername,
  verifyPassword,
  create,
  update,
  remove,
  touchLogin,
  publicUser,
};
