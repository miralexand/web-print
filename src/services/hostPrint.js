'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.txt': 'text/plain; charset=utf-8',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * 将待打印文件提交给本地打印服务。
 * @param {object} task 队列任务
 */
async function submit(task) {
  const filePath = task._filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('待打印文件不存在或已被清理');
  }

  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeFor(filePath) }), task.originalName);
  form.append('copies', String(task.copies));
  form.append('pages', task.pages || '');
  form.append('color', task.color);
  form.append('paperSize', task.paperSize || '');
  form.append('orientation', task.orientation === 'landscape' ? 'landscape' : 'portrait');
  form.append('printer', task.printer || '');
  form.append('jobId', task.id);

  const headers = {};
  if (config.hostPrintToken) headers['x-print-token'] = config.hostPrintToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.hostPrintTimeout);

  try {
    const res = await fetch(`${config.hostPrintApi}/print`, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { message: text };
    }
    if (!res.ok || data.success === false) {
      throw new Error(data.message || `本地打印服务返回 ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`本地打印服务响应超时（${config.hostPrintApi}）`);
    }
    const e = new Error(`无法连接本地打印服务（${config.hostPrintApi}）。请确认应用「概览」中的“打印服务”已启动；若刚启动请稍候重试。`);
    e.connection = true;
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function listPrinters() {
  const headers = {};
  if (config.hostPrintToken) headers['x-print-token'] = config.hostPrintToken;
  const res = await fetch(`${config.hostPrintApi}/printers`, { headers });
  if (!res.ok) throw new Error(`获取打印机列表失败：${res.status}`);
  return res.json();
}

async function ping() {
  try {
    const res = await fetch(`${config.hostPrintApi}/health`);
    return res.ok;
  } catch (err) {
    logger.warn(`本地打印服务不可用：${err.message}`);
    return false;
  }
}

module.exports = { submit, listPrinters, ping };
