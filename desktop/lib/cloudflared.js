'use strict';

/**
 * Cloudflare Tunnel 管理。
 * 支持三种运行方式：
 *   - quick：cloudflared tunnel --url <目标地址>，解析 trycloudflare 公网地址
 *   - token：cloudflared tunnel run --token <token>（应用内启动连接器）
 *   - 兼容已用 `cloudflared service install <token>` 安装的 Windows 系统服务：
 *       检测到服务在运行时，应用不会重复启动，避免连接器/端口冲突报错
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

function findCloudflared(extra) {
  const candidates = [
    extra,
    process.env.CLOUDFLARED_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return 'cloudflared';
}

/**
 * 从用户输入中提取纯 Tunnel Token。
 * 兼容直接粘贴 `cloudflared.exe service install eyJ...` 这样的完整命令。
 */
function normalizeToken(input) {
  let text = String(input == null ? '' : input).trim();
  if (!text) return '';
  text = text.replace(/^["'`]|["'`]$/g, '');
  const jwt = text.match(/eyJ[A-Za-z0-9._-]{20,}/);
  if (jwt) return jwt[0];
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice().sort((a, b) => b.length - a.length)[0];
  return text;
}

function queryCloudflaredService() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ installed: false, running: false });
    execFile('sc', ['query', 'cloudflared'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ installed: false, running: false });
      return resolve({ installed: true, running: /RUNNING/i.test(stdout || '') });
    });
  });
}

function runCommand(exe, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err) return resolve({ ok: false, error: output || err.message, output });
      return resolve({ ok: true, output });
    });
  });
}

class CloudflaredManager {
  constructor(options = {}) {
    this.config = {
      mode: 'quick',
      url: 'http://127.0.0.1:3000',
      token: '',
      cloudflaredPath: '',
    };
    this.proc = null;
    this.running = false;
    this.managedByService = false;
    this.url = '';
    this.error = '';
    this.logs = [];
    this.serviceStatus = { installed: false, running: false };
    this.onChange = options.onChange || (() => {});
    this._poll = setInterval(() => this.refreshService(), 5000);
  }

  setConfig(patch = {}) {
    this.config = { ...this.config, ...patch };
    if (this.config.token) this.config.token = normalizeToken(this.config.token);
  }

  log(line) {
    const text = String(line).trimEnd();
    if (!text) return;
    this.logs.push(text);
    if (this.logs.length > 300) this.logs.shift();
    this.onChange();
  }

  state() {
    return {
      running: this.running,
      url: this.url,
      error: this.error,
      logs: this.logs.slice(-100),
      mode: this.config.mode,
      targetUrl: this.config.url,
      token: this.config.token,
      cloudflaredPath: this.config.cloudflaredPath,
      resolvedPath: this.resolvedPath(),
      managedByService: this.managedByService,
      service: this.serviceStatus,
    };
  }

  resolvedPath() {
    return this.config.cloudflaredPath || findCloudflared();
  }

  async refreshService() {
    const next = await queryCloudflaredService();
    const changed = next.installed !== this.serviceStatus.installed || next.running !== this.serviceStatus.running;
    this.serviceStatus = next;
    if (next.running) {
      if (!this.managedByService) {
        this.managedByService = true;
        this.running = true;
        this.log('检测到 cloudflared 已作为 Windows 系统服务运行，应用将不再重复启动。');
      }
    } else if (this.managedByService && !this.proc) {
      this.managedByService = false;
      this.running = false;
    }
    if (changed) this.onChange();
    return this.serviceStatus;
  }

  async start() {
    this.error = '';
    this.url = '';
    await this.refreshService();

    if (this.config.mode === 'token') {
      const token = normalizeToken(this.config.token);
      this.config.token = token;
      if (!token) {
        this.error = '未检测到有效的 Tunnel Token：请粘贴以 eyJ 开头的 Token，或直接粘贴 `cloudflared service install eyJ...` 整条命令。';
        this.onChange();
        return this.state();
      }
      if (this.serviceStatus.running) {
        this.managedByService = true;
        this.running = true;
        this.log('隧道由 Windows 系统服务托管，运行中；如需修改请先卸载系统服务。');
        this.onChange();
        return this.state();
      }
    }

    const exe = this.resolvedPath();
    let args;
    if (this.config.mode === 'token') {
      args = ['tunnel', 'run', '--token', this.config.token, '--no-autoupdate'];
    } else {
      const target = this.config.url || 'http://127.0.0.1:3000';
      args = ['tunnel', '--url', target, '--no-autoupdate'];
    }

    this.log(`启动命令：${exe} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

    try {
      this.proc = spawn(exe, args, { windowsHide: true });
    } catch (err) {
      this.error = `无法启动 cloudflared：${err.message}`;
      this.running = false;
      this.onChange();
      return this.state();
    }

    this.running = true;
    this.managedByService = false;
    this.onChange();

    const handle = (chunk) => {
      const text = chunk.toString();
      this.log(text);
      const matches = text.match(URL_RE);
      if (matches && matches.length) {
        this.url = matches[matches.length - 1];
        this.onChange();
      }
    };

    this.proc.stdout.on('data', handle);
    this.proc.stderr.on('data', handle);

    this.proc.on('error', (err) => {
      this.error = `cloudflared 运行错误：${err.message}（请检查路径或是否已安装）`;
      this.running = false;
      this.onChange();
    });

    this.proc.on('close', (code) => {
      this.running = false;
      this.proc = null;
      if (code !== 0 && !this.url) {
        this.error = `cloudflared 已退出（退出码 ${code}），请查看下方日志。常见原因：Token 无效、隧道未配置 Public Hostname，或已被系统服务占用。`;
      }
      this.log(`cloudflared 已退出，退出码 ${code}`);
      this.onChange();
    });

    return this.state();
  }

  stop() {
    if (this.managedByService && !this.proc) {
      this.log('隧道由 Windows 系统服务托管，已停止应用内管理；如需彻底停止请在服务管理器停止 cloudflared 服务，或点击“卸载系统服务”。');
      this.managedByService = false;
      this.running = false;
      this.url = '';
      this.onChange();
      return this.state();
    }
    if (!this.proc) {
      this.running = false;
      return this.state();
    }
    const pid = this.proc.pid;
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.proc.kill('SIGTERM');
      }
    } catch (_) {
      /* ignore */
    }
    this.running = false;
    this.proc = null;
    this.onChange();
    return this.state();
  }

  /** 以 Windows 服务方式安装并接管隧道（需要管理员权限） */
  async installService() {
    const token = normalizeToken(this.config.token);
    if (!token) {
      return { ok: false, error: '请先填写 Tunnel Token，再安装为系统服务。' };
    }
    this.config.token = token;
    const result = await runCommand(this.resolvedPath(), ['service', 'install', token]);
    await this.refreshService();
    this.onChange();
    if (!result.ok) {
      return { ok: false, error: `${result.error}\n（安装系统服务通常需要以管理员身份运行本程序）` };
    }
    return { ok: true, output: result.output };
  }

  /** 卸载 cloudflared Windows 服务（需要管理员权限） */
  async uninstallService() {
    const result = await runCommand(this.resolvedPath(), ['service', 'uninstall']);
    await this.refreshService();
    this.onChange();
    if (!result.ok) return { ok: false, error: `${result.error}\n（卸载系统服务通常需要以管理员身份运行本程序）` };
    return { ok: true, output: result.output };
  }

  dispose() {
    clearInterval(this._poll);
    this.stop();
  }
}

module.exports = { CloudflaredManager, findCloudflared, normalizeToken, queryCloudflaredService };
