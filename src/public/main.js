'use strict';

const $ = (id) => document.getElementById(id);
let selectedFile = null;
let refreshTimer = null;

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : {};
  if (!res.ok) {
    throw new Error(data.error || `请求失败：${res.status}`);
  }
  return data;
}

function showLogin() {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
  stopRefresh();
}

function showApp(user) {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('current-user').textContent = user ? user.username : '';
  loadPrinters();
  checkAgent();
  refreshTasks();
  startRefresh();
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(refreshTasks, 4000);
}
function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---- 鉴权 ----
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('login-user').value.trim(),
        password: $('login-pass').value,
      }),
    });
    showApp(user);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  showLogin();
});

// ---- 文件选择 / 拖拽 ----
const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

function setFile(file) {
  const maxMb = 20;
  if (file.size > maxMb * 1024 * 1024) {
    setMsg(`文件超过 ${maxMb}MB 限制`, false);
    return;
  }
  selectedFile = file;
  $('file-label').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
}

// ---- 提交打印 ----
$('print-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('', true);
  if (!selectedFile) {
    setMsg('请先选择要打印的文件', false);
    return;
  }
  const form = new FormData();
  form.append('file', selectedFile);
  form.append('copies', $('opt-copies').value);
  form.append('color', $('opt-color').value);
  form.append('paperSize', $('opt-paper').value);
  form.append('printer', $('opt-printer').value);

  const btn = $('submit-btn');
  btn.disabled = true;
  try {
    await api('/api/print', { method: 'POST', body: form });
    setMsg('已提交，正在排队打印', true);
    selectedFile = null;
    fileInput.value = '';
    $('file-label').textContent = '点击或拖拽文件到此处';
    refreshTasks();
  } catch (err) {
    setMsg(err.message, false);
  } finally {
    btn.disabled = false;
  }
});

function setMsg(text, ok) {
  const el = $('print-msg');
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

// ---- 打印机 / 状态 ----
async function loadPrinters() {
  try {
    const data = await api('/api/printers');
    const list = data.printers || [];
    const select = $('opt-printer');
    select.innerHTML = '<option value="">默认打印机</option>';
    list.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name || p.deviceId;
      opt.textContent = p.name || p.deviceId;
      select.appendChild(opt);
    });
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（未检测到打印机）';
      opt.disabled = true;
      select.appendChild(opt);
    }
  } catch (_) {
    /* Agent 不可用时静默处理 */
  }
}

async function checkAgent() {
  const badge = $('agent-status');
  try {
    const data = await api('/api/status');
    const online = data.hostPrintAgent === 'online';
    badge.textContent = online ? '打印服务在线' : '打印服务离线';
    badge.className = `badge ${online ? 'online' : 'offline'}`;
  } catch (_) {
    badge.textContent = '状态未知';
    badge.className = 'badge offline';
  }
}

// ---- 任务列表 ----
const STATUS_TEXT = {
  pending: '等待中',
  processing: '打印中',
  success: '已完成',
  failed: '失败',
  canceled: '已取消',
};

async function refreshTasks() {
  try {
    const { tasks } = await api('/api/tasks');
    renderTasks(tasks);
  } catch (err) {
    if (/未登录/.test(err.message)) showLogin();
  }
}

function renderTasks(tasks) {
  const body = $('task-body');
  if (!tasks.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">暂无任务</td></tr>';
    return;
  }
  body.innerHTML = '';
  tasks.forEach((t) => {
    const tr = document.createElement('tr');
    const errorHint = t.status === 'failed' && t.error ? `<div class="params">${escapeHtml(t.error)}</div>` : '';
    tr.innerHTML = `
      <td><div class="filename" title="${escapeHtml(t.originalName)}">${escapeHtml(t.originalName)}</div></td>
      <td class="params">${t.copies} 份 · ${t.color === 'color' ? '彩色' : '黑白'} · ${escapeHtml(t.paperSize)}</td>
      <td><span class="status ${t.status}">${STATUS_TEXT[t.status] || t.status}</span>${errorHint}</td>
      <td class="params">${formatTime(t.createdAt)}</td>
      <td>${t.status === 'pending' ? '<button class="ghost" data-cancel="' + t.id + '">取消</button>' : ''}</td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/tasks/${btn.dataset.cancel}`, { method: 'DELETE' });
        refreshTasks();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

$('refresh-btn').addEventListener('click', () => {
  refreshTasks();
  checkAgent();
});

// ---- 启动 ----
(async function init() {
  try {
    const { user } = await api('/api/me');
    showApp(user);
  } catch (_) {
    showLogin();
  }
})();
