'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let busy = false;

function render(s) {
  state = s || state;
  if (!state) return;
  const running = !!state.running;

  $('status-dot').className = `dot ${running ? 'on' : 'off'}`;
  const badge = $('status-text');
  badge.textContent = running ? '服务运行中' : '服务已停止';
  badge.className = `badge ${running ? 'on' : 'off'}`;

  $('addr').textContent = `http://${state.host}:${state.port}`;
  $('info-running').textContent = running ? '运行中' : '已停止';
  $('info-soffice').textContent = state.sofficePath || '未找到';
  $('toggle-btn').textContent = running ? '停止服务' : '启动服务';
  $('toggle-btn').className = running ? 'ghost' : 'primary';

  if (document.activeElement !== $('cfg-port')) $('cfg-port').value = state.port;
  if (document.activeElement !== $('cfg-token')) $('cfg-token').value = state.token || '';
  if (document.activeElement !== $('cfg-soffice')) $('cfg-soffice').value = state.sofficePath || '';
  $('cfg-autostart').checked = !!state.autoStart;

  const logs = (state.logs || []).join('\n');
  $('logs').textContent = logs || '暂无日志';
  $('logs').scrollTop = $('logs').scrollHeight;
}

async function refresh() {
  render(await window.trayApi.getState());
}

async function loadPrinters() {
  const body = $('printer-body');
  body.innerHTML = '<tr><td colspan="2" class="empty">加载中…</td></tr>';
  const res = await window.trayApi.getPrinters();
  if (!res.ok) {
    body.innerHTML = `<tr><td colspan="2" class="empty">${escapeHtml(res.error || '获取失败')}</td></tr>`;
    $('info-printers').textContent = '0';
    return;
  }
  const printers = res.printers || [];
  $('info-printers').textContent = String(printers.length);
  if (!printers.length) {
    body.innerHTML = '<tr><td colspan="2" class="empty">未检测到打印机</td></tr>';
    return;
  }
  body.innerHTML = '';
  printers.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(p.name || p.deviceId)}</td><td class="value small">${escapeHtml((p.paperSizes || []).slice(0, 4).join('、') || '-')}</td>`;
    body.appendChild(tr);
  });
}

$('toggle-btn').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('toggle-btn').disabled = true;
  try {
    const res = state && state.running ? await window.trayApi.stop() : await window.trayApi.start();
    if (res && res.state) render(res.state);
    else await refresh();
    if (res && res.ok === false) setMsg(res.error, false);
  } finally {
    busy = false;
    $('toggle-btn').disabled = false;
  }
});

$('refresh-btn').addEventListener('click', loadPrinters);
$('open-web-btn').addEventListener('click', () => window.trayApi.openWeb());
$('hide-btn').addEventListener('click', () => window.trayApi.hide());

$('pick-soffice').addEventListener('click', async () => {
  const res = await window.trayApi.pickSoffice();
  if (res.ok) $('cfg-soffice').value = res.path;
});

$('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('保存中…', true);
  const res = await window.trayApi.saveConfig({
    port: $('cfg-port').value,
    token: $('cfg-token').value,
    sofficePath: $('cfg-soffice').value,
    autoStart: $('cfg-autostart').checked,
  });
  if (res.ok) {
    render(res.state);
    setMsg('设置已保存', true);
  } else {
    setMsg(res.error || '保存失败', false);
  }
});

function setMsg(text, ok) {
  const el = $('cfg-msg');
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
  if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

window.trayApi.onStateChanged(render);

(async function init() {
  await refresh();
  loadPrinters();
  setInterval(async () => {
    const latest = await window.trayApi.getState();
    render(latest);
  }, 3000);
})();
