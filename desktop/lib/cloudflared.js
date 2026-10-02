'use strict';

/**
 * Cloudflare Tunnel 管理：以子进程方式启停 cloudflared。
 * - quick 模式：cloudflared tunnel --url <目标地址>，解析 trycloudflare 公网地址
 * - token 模式：cloudflared tunnel run --token <token>
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
    this.url = '';
    this.error = '';
    this.logs = [];
    this.onChange = options.onChange || (() => {});
  }

  setConfig(patch = {}) {
    this.config = { ...this.config, ...patch };
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
    };
  }

  resolvedPath() {
    return this.config.cloudflaredPath || findCloudflared();
  }

  start() {
    if (this.running) return this.state();
    this.error = '';
    this.url = '';
    const exe = this.resolvedPath();

    let args;
    if (this.config.mode === 'token') {
      if (!this.config.token) {
        this.error = '命名隧道模式需要填写 Tunnel Token';
        this.onChange();
        return this.state();
      }
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
        this.error = this.error || `cloudflared 已退出（退出码 ${code}）`;
      }
      this.log(`cloudflared 已退出，退出码 ${code}`);
      this.onChange();
    });

    return this.state();
  }

  stop() {
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

  dispose() {
    this.stop();
  }
}

module.exports = { CloudflaredManager, findCloudflared };
