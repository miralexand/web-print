'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');
const hostPrint = require('./hostPrint');
const limiter = require('./usageLimiter');

const TASKS_FILE = () => path.join(config.logFolder, 'tasks.json');
const MAX_TASKS = 500;

let tasks = [];
let processing = false;
let saveTimer = null;
let retryTimer = null;
const MAX_CONN_RETRIES = 5;

function isConnectionError(err) {
  if (!err) return false;
  if (err.connection) return true;
  return /无法连接|ECONNREFUSED|fetch failed|socket hang up|超时/i.test(err.message || '');
}

function now() {
  return new Date().toISOString();
}

function addLog(task, level, message) {
  task.logs.push({ time: now(), level, message });
  if (task.logs.length > 100) task.logs = task.logs.slice(-100);
}

function refundQuota(task) {
  if (task._quotaKey && task._quotaToken) {
    limiter.refund(task._quotaKey, task._quotaToken);
    task._quotaKey = null;
    task._quotaToken = null;
  }
}

function load() {
  try {
    const file = TASKS_FILE();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        tasks = parsed;
        tasks.forEach((t) => {
          if (t.status === 'processing' || t.status === 'pending') {
            t.status = 'failed';
            t.error = '服务重启，任务中断';
            addLog(t, 'error', '服务重启，任务中断，已退还配额');
            refundQuota(t);
          }
        });
      }
    }
  } catch (err) {
    logger.error('加载任务记录失败', err);
    tasks = [];
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.logFolder, { recursive: true });
      fs.writeFileSync(TASKS_FILE(), JSON.stringify(tasks, null, 2), 'utf8');
    } catch (err) {
      logger.error('保存任务记录失败', err);
    }
  }, 150);
}

function createTask(input) {
  const task = {
    id: crypto.randomUUID(),
    createdAt: now(),
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    error: null,
    logs: [],
    ...input,
  };
  addLog(task, 'info', '任务已创建，等待打印');
  tasks.unshift(task);
  if (tasks.length > MAX_TASKS) tasks = tasks.slice(0, MAX_TASKS);
  save();
  setImmediate(processQueue);
  return task;
}

function cleanupFile(task) {
  if (task._filePath) {
    try {
      fs.unlinkSync(task._filePath);
    } catch (_) {
      /* 已删除或不存在 */
    }
    delete task._filePath;
  }
}

async function runTask(task) {
  task.status = 'processing';
  task.startedAt = now();
  addLog(task, 'info', '开始处理打印任务');
  save();
  try {
    await hostPrint.submit(task);
    task.status = 'success';
    addLog(task, 'info', '打印任务已成功提交到打印机');
    task.finishedAt = now();
    cleanupFile(task);
    save();
    return false;
  } catch (err) {
    // 本地打印服务尚未就绪：自动重试，避免“无法连接”直接把任务判失败
    if (isConnectionError(err) && (task.retries || 0) < MAX_CONN_RETRIES) {
      task.retries = (task.retries || 0) + 1;
      task.status = 'pending';
      task.startedAt = null;
      addLog(task, 'warn', `本地打印服务未就绪，10 秒后自动重试（第 ${task.retries}/${MAX_CONN_RETRIES} 次）`);
      save();
      return true;
    }
    task.status = 'failed';
    task.error = err.message;
    addLog(task, 'error', `打印失败：${err.message}，已退还配额`);
    refundQuota(task);
    logger.error(`任务 ${task.id} 打印失败`, err);
    task.finishedAt = now();
    cleanupFile(task);
    save();
    return false;
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const task = [...tasks].reverse().find((t) => t.status === 'pending');
      if (!task) break;
      const needRetry = await runTask(task);
      if (needRetry) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          processQueue();
        }, 10000);
        break;
      }
    }
  } finally {
    processing = false;
  }
}

function publicTask(task) {
  const { _filePath, _quotaKey, _quotaToken, ...rest } = task;
  return rest;
}

function listTasks(predicate) {
  const mapped = tasks.map(publicTask);
  return typeof predicate === 'function' ? mapped.filter(predicate) : mapped;
}

function getTask(id) {
  const task = tasks.find((t) => t.id === id);
  return task ? publicTask(task) : null;
}

function cancelTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status !== 'pending') return { ok: false, error: '仅可取消等待中的任务' };
  task.status = 'canceled';
  task.finishedAt = now();
  addLog(task, 'warn', '任务已被取消，已退还配额');
  refundQuota(task);
  cleanupFile(task);
  save();
  return { ok: true, task: publicTask(task) };
}

module.exports = {
  load,
  createTask,
  processQueue,
  listTasks,
  getTask,
  cancelTask,
  publicTask,
};
