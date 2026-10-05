'use strict';

const $ = (id) => document.getElementById(id);
let selectedFile = null;
let previewUrl = null;
let currentUser = null;
let refreshTimer = null;
let editingUserId = null;

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : {};
  if (!res.ok) {
    const err = new Error(data.error || `请求失败：${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------- 身份与顶栏 ----------------
async function loadMe() {
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    applyIdentity();
    renderQuota(data.quota);
  } catch (err) {
    if (err.status === 401) {
      currentUser = null;
      applyIdentity();
    }
  }
}

function applyIdentity() {
  const loggedIn = !!currentUser;
  const isAdmin = loggedIn && currentUser.role === 'admin';
  $('login-btn').classList.toggle('hidden', loggedIn);
  $('logout-btn').classList.toggle('hidden', !loggedIn);
  $('admin-btn').classList.toggle('hidden', !isAdmin);
  $('current-user').textContent = loggedIn
    ? `${currentUser.username}（${isAdmin ? '管理员' : '用户'}）`
    : '游客';
  $('print-mode').textContent = loggedIn
    ? '已登录'
    : `游客模式：每 ${$('quota-badge').dataset.window || 3} 小时限额打印`;
  if (!isAdmin) $('admin-panel').classList.add('hidden');
}

function renderQuota(quota) {
  const el = $('quota-badge');
  if (!quota) { el.textContent = '…'; el.className = 'badge'; return; }
  if (quota.unlimited) {
    el.textContent = '不限次数';
    el.className = 'badge online';
    el.title = '该账号未设置打印次数限制';
    return;
  }
  el.dataset.window = quota.windowHours;
  el.textContent = `剩余 ${quota.remaining}/${quota.limit} 次`;
  el.className = `badge ${quota.remaining > 0 ? 'online' : 'offline'}`;
  el.title = `每 ${quota.windowHours} 小时最多 ${quota.limit} 次，重置时间 ${new Date(quota.resetAt).toLocaleString('zh-CN')}`;
}

// ---------------- 登录 / 退出 ----------------
$('login-btn').addEventListener('click', openLogin);
$('cancel-login').addEventListener('click', closeLogin);
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value }),
    });
    $('login-pass').value = '';
    closeLogin();
    await loadMe();
    loadPrinters();
    checkAgent();
    refreshTasks();
    if (currentUser && currentUser.role === 'admin') {
      $('admin-panel').classList.remove('hidden');
      loadUsers();
      loadUsage();
    }
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  currentUser = null;
  applyIdentity();
  $('admin-panel').classList.add('hidden');
  await loadMe();
  refreshTasks();
});

function openLogin() {
  $('login-modal').classList.remove('hidden');
  $('login-error').textContent = '';
  $('login-user').focus();
}
function closeLogin() { $('login-modal').classList.add('hidden'); }

$('admin-btn').addEventListener('click', () => {
  const panel = $('admin-panel');
  const show = panel.classList.toggle('hidden');
  if (!show) { loadUsers(); loadUsage(); }
});

// ---------------- 文件选择 ----------------
const dropzone = $('dropzone');
const fileInput = $('file-input');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });
$('clear-file-btn').addEventListener('click', () => clearFile(false));

function setFile(file) {
  const maxMb = 20;
  if (file.size > maxMb * 1024 * 1024) { setMsg(`文件超过 ${maxMb}MB 限制`, false); return; }
  clearFile(true);
  selectedFile = file;
  $('file-label').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
  showPreview(file);
  setMsg('', true);
}

function showPreview(file) {
  const img = $('preview-img');
  const pdf = $('preview-pdf');
  const generic = $('preview-generic');
  img.classList.add('hidden');
  pdf.classList.add('hidden');
  generic.classList.add('hidden');
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  previewUrl = URL.createObjectURL(file);
  if (type.startsWith('image/') || /\.(png|jpe?g)$/.test(name)) {
    img.src = previewUrl;
    img.classList.remove('hidden');
  } else if (type === 'application/pdf' || name.endsWith('.pdf')) {
    pdf.src = previewUrl;
    pdf.classList.remove('hidden');
  } else {
    generic.classList.remove('hidden');
  }
  $('preview-name').textContent = file.name;
  $('preview-size').textContent = `${(file.size / 1024).toFixed(0)} KB`;
  $('file-preview').classList.remove('hidden');
}

function clearFile(silent) {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  selectedFile = null;
  if (fileInput) fileInput.value = '';
  $('file-label').textContent = '点击或拖拽文件到此处';
  const preview = $('file-preview');
  if (preview) preview.classList.add('hidden');
  $('preview-img').src = '';
  $('preview-pdf').src = '';
  if (!silent) setMsg('已移除，请重新选择文件', true);
}

function buildPages() {
  const from = String($('opt-page-from').value || '').trim();
  const to = String($('opt-page-to').value || '').trim();
  if (!from && !to) return '';
  const f = Number.parseInt(from, 10);
  const t = Number.parseInt(to, 10);
  if (from && to) {
    const a = Math.min(f, t);
    const b = Math.max(f, t);
    return `${a}-${b}`;
  }
  if (from) return String(f);
  return `1-${t}`;
}

// ---------------- 提交打印 ----------------
$('print-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('', true);
  if (!selectedFile) { setMsg('请先选择要打印的文件', false); return; }
  const form = new FormData();
  form.append('file', selectedFile);
  form.append('copies', $('opt-copies').value);
  form.append('pages', buildPages());
  form.append('color', $('opt-color').value);
  form.append('paperSize', $('opt-paper').value);
  form.append('printer', $('opt-printer').value);

  const btn = $('submit-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/print', { method: 'POST', body: form });
    renderQuota(data.quota);
    setMsg('已提交，正在排队打印', true);
    clearFile(true);
    refreshTasks();
  } catch (err) {
    if (err.data && err.data.quota) renderQuota(err.data.quota);
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

// ---------------- 打印机 / Agent ----------------
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
      opt.textContent = '（未检测到打印机）';
      opt.disabled = true;
      select.appendChild(opt);
    }
  } catch (_) { /* Agent 不可用时静默 */ }
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

// ---------------- 任务列表 ----------------
const STATUS_TEXT = {
  pending: '等待中', processing: '打印中', success: '已完成', failed: '失败', canceled: '已取消',
};

async function refreshTasks() {
  try {
    const data = await api('/api/tasks');
    renderTasks(data.tasks || []);
    if (data.quota) renderQuota(data.quota);
  } catch (err) {
    if (err.status === 401) { currentUser = null; applyIdentity(); }
  }
}

function renderTasks(tasks) {
  const body = $('task-body');
  if (!tasks.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">暂无任务</td></tr>';
    return;
  }
  body.innerHTML = '';
  tasks.forEach((t) => {
    const tr = document.createElement('tr');
    const errorHint = t.status === 'failed' && t.error ? `<div class="params">${escapeHtml(t.error)}</div>` : '';
    const pagesText = t.pages ? `第 ${escapeHtml(t.pages)} 页 · ` : '';
    const action = t.status === 'processing'
      ? '<span class="params">打印中…</span>'
      : `<button class="btn ghost" data-delete="${t.id}">删除</button>`;
    tr.innerHTML = `
      <td><div class="filename" title="${escapeHtml(t.originalName)}">${escapeHtml(t.originalName)}</div></td>
      <td class="params">${t.copies} 份 · ${pagesText}${t.color === 'color' ? '彩色' : '黑白'} · ${escapeHtml(t.paperSize)}</td>
      <td class="params">${escapeHtml(t.ownerName || '-')}</td>
      <td><span class="status ${t.status}">${STATUS_TEXT[t.status] || t.status}</span>${errorHint}</td>
      <td class="params">${formatTime(t.createdAt)}</td>
      <td><div class="actions">${action}</div></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const data = await api(`/api/tasks/${btn.dataset.delete}`, { method: 'DELETE' });
        if (data && data.quota) renderQuota(data.quota);
        refreshTasks();
      } catch (err) { alert(err.message); }
    });
  });
}

// ---------------- 用户管理 ----------------
$('new-user-btn').addEventListener('click', () => resetUserForm(true));
$('cancel-user').addEventListener('click', () => $('user-form').classList.add('hidden'));

function resetUserForm(show) {
  editingUserId = null;
  $('user-id').value = '';
  $('user-name').value = '';
  $('user-pass').value = '';
  $('user-role').value = 'user';
  $('user-quota').value = '0';
  $('user-window').value = '3';
  $('user-enabled').checked = true;
  $('user-msg').textContent = '';
  $('user-form').classList.toggle('hidden', !show);
  if (show) $('user-name').focus();
}

function fillUserForm(user) {
  editingUserId = user.id;
  $('user-id').value = user.id;
  $('user-name').value = user.username;
  $('user-pass').value = '';
  $('user-role').value = user.role;
  $('user-quota').value = user.printQuota;
  $('user-window').value = user.quotaWindowHours;
  $('user-enabled').checked = user.enabled;
  $('user-msg').textContent = '';
  $('user-form').classList.remove('hidden');
}

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('user-msg').textContent = '';
  const payload = {
    username: $('user-name').value.trim(),
    role: $('user-role').value,
    enabled: $('user-enabled').checked,
    printQuota: $('user-quota').value,
    quotaWindowHours: $('user-window').value,
  };
  const pass = $('user-pass').value;
  if (pass) payload.password = pass;
  if (!editingUserId && !pass) { $('user-msg').textContent = '新增用户必须设置密码'; return; }

  try {
    if (editingUserId) {
      await api(`/api/admin/users/${editingUserId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    resetUserForm(false);
    loadUsers();
  } catch (err) {
    $('user-msg').textContent = err.message;
  }
});

async function loadUsers() {
  const body = $('user-body');
  try {
    const { users } = await api('/api/admin/users');
    if (!users.length) { body.innerHTML = '<tr><td colspan="6" class="empty">暂无用户</td></tr>'; return; }
    body.innerHTML = '';
    users.forEach((u) => {
      const quotaText = u.printQuota > 0 ? `${u.printQuota} 次 / ${u.quotaWindowHours} 小时` : '不限';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td><span class="tag ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
        <td>${u.enabled ? '<span class="tag">启用</span>' : '<span class="tag off">停用</span>'}</td>
        <td class="params">${quotaText}</td>
        <td class="params">${u.lastLoginAt ? formatTime(u.lastLoginAt) : '从未'}</td>
        <td><div class="actions">
          <button class="ghost" data-edit="${u.id}">编辑</button>
          <button class="ghost" data-toggle="${u.id}" data-enabled="${u.enabled}">${u.enabled ? '停用' : '启用'}</button>
          <button class="ghost" data-del="${u.id}">删除</button>
        </div></td>
      `;
      body.appendChild(tr);
      tr.querySelector('[data-edit]').addEventListener('click', () => fillUserForm(u));
      tr.querySelector('[data-toggle]').addEventListener('click', async () => {
        try {
          await api(`/api/admin/users/${u.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !u.enabled }),
          });
          loadUsers();
        } catch (err) { alert(err.message); }
      });
      tr.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm(`确定删除用户「${u.username}」？`)) return;
        try {
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          loadUsers();
        } catch (err) { alert(err.message); }
      });
    });
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---------------- 用量 ----------------
async function loadUsage() {
  const body = $('usage-body');
  try {
    const { usage } = await api('/api/admin/usage');
    if (!usage.length) { body.innerHTML = '<tr><td colspan="4" class="empty">暂无记录</td></tr>'; return; }
    body.innerHTML = '';
    usage.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="params">${escapeHtml(row.key)}</td>
        <td>${row.count}</td>
        <td class="params">${formatTime(row.last)}</td>
        <td><div class="actions"><button class="ghost" data-reset="${escapeHtml(row.key)}">重置</button></div></td>
      `;
      tr.querySelector('[data-reset]').addEventListener('click', async () => {
        try {
          await api('/api/admin/usage/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: row.key }),
          });
          loadUsage();
        } catch (err) { alert(err.message); }
      });
      body.appendChild(tr);
    });
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---------------- 手机接入（扫码添加） ----------------
const MAX_QR_BYTES = 1024; // 与后端 /api/qrcode 的上限保持一致
let accessCandidates = [];

async function loadAccessInfo() {
  const card = $('access-card');
  const errorEl = $('access-error');
  try {
    const data = await api('/api/access-info');
    const list = Array.isArray(data.candidates) ? data.candidates : [];
    if (!list.length) {
      // 客户端只允许 HTTPS：没有可用 https 入口时给出明确指引，而不是笼统报错
      accessCandidates = [];
      $('access-body').classList.add('hidden');
      errorEl.textContent = data.hint || '当前没有可用的 HTTPS 接入地址。';
      errorEl.classList.remove('hidden');
      card.classList.remove('hidden');
      return;
    }
    accessCandidates = list;
    const select = $('access-select');
    select.innerHTML = '';
    list.forEach((item, index) => {
      const opt = document.createElement('option');
      opt.value = String(index);
      // 回环地址手机无法访问，额外标注避免误选；隧道地址为推荐项
      const suffix = item.kind === 'loopback' ? '（手机无法访问）' : (item.kind === 'tunnel' ? '（推荐）' : '');
      opt.textContent = `${item.label}${suffix}`;
      select.appendChild(opt);
    });
    // 隧道地址优先：客户端仅允许 HTTPS，明文入口对手机没有意义
    const preferred = list.findIndex((item) => item.kind === 'tunnel');
    const currentIndex = list.findIndex((item) => item.kind === 'current');
    select.value = String(preferred >= 0 ? preferred : (currentIndex >= 0 ? currentIndex : 0));
    errorEl.classList.add('hidden');
    $('access-body').classList.remove('hidden');
    renderAccessQr();
    card.classList.remove('hidden');
  } catch (err) {
    // 接口不可用时只做提示，不影响页面其他功能
    $('access-body').classList.add('hidden');
    errorEl.textContent = `无法获取接入地址：${err.message}`;
    errorEl.classList.remove('hidden');
    card.classList.remove('hidden');
  }
}

function renderAccessQr() {
  const item = accessCandidates[Number($('access-select').value)] || accessCandidates[0];
  if (!item) return;
  $('access-url').textContent = item.url;
  $('copy-msg').textContent = '';
  const img = $('access-qr');
  // 内容过长时后端返回 400，img 只会加载失败，这里提前判断
  if (byteLength(item.url) > MAX_QR_BYTES) {
    img.removeAttribute('src');
    img.classList.add('hidden');
    $('copy-msg').textContent = '地址过长，无法生成二维码';
    return;
  }
  img.classList.remove('hidden');
  img.src = `/api/qrcode?data=${encodeURIComponent(item.url)}&scale=6&margin=4`;
}

async function copyAccessUrl() {
  const url = $('access-url').textContent || '';
  if (!url) return;
  const ok = await copyText(url);
  const msg = $('copy-msg');
  msg.textContent = ok ? '已复制' : '复制失败，请手动选择地址';
  setTimeout(() => { if (msg.textContent) msg.textContent = ''; }, 2000);
}

// 页面常以 http 在内网提供，此时 navigator.clipboard 不可用，回落到 execCommand
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 回落到 execCommand */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (_) {
    return false;
  }
}

function byteLength(str) {
  const text = String(str == null ? '' : str);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
}

$('access-select').addEventListener('change', renderAccessQr);
$('copy-url-btn').addEventListener('click', copyAccessUrl);
$('access-qr').addEventListener('load', () => { $('copy-msg').textContent = ''; });
$('access-qr').addEventListener('error', () => { $('copy-msg').textContent = '二维码生成失败，请换一个地址'; });

// ---------------- 工具 ----------------
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

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshTasks, 4000);
}

$('refresh-btn').addEventListener('click', () => { refreshTasks(); checkAgent(); loadMe(); });
$('refresh-usage').addEventListener('click', () => loadUsage());

// ---------------- 启动 ----------------
(async function init() {
  await loadMe();
  loadPrinters();
  checkAgent();
  refreshTasks();
  loadAccessInfo();
  startRefresh();
  if (currentUser && currentUser.role === 'admin') {
    $('admin-panel').classList.remove('hidden');
    loadUsers();
    loadUsage();
  }
})();
