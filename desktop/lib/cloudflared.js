'use strict';

/**
 * Cloudflare Tunnel 管理（支持“快速隧道 + 命名隧道”同时运行）。
 *   - quick：cloudflared tunnel --url <目标地址>，解析 trycloudflare 公网地址
 *   - token：cloudflared tunnel run --token <token>
 * 两条隧道各自独立启停，互不影响；快速隧道支持自动重建与刷新。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const QUICK_URL_WAIT_MS = 30000;

// 命名隧道：cloudflared 启动后会把从 Cloudflare 拉取的远端配置打印到日志里，
// 其 ingress 规则带有 hostname（形如 \"hostname\":\"print.example.com\"）。
// 从中提取固定域名，供网页端「手机接入」生成二维码；免去用户手填公开地址。
const HOSTNAME_RE = /\\?"hostname\\?"\s*:\s*\\?"([^"\\]+)\\?"/gi;

function extractTunnelHostname(text) {
  HOSTNAME_RE.lastIndex = 0;
  const m = HOSTNAME_RE.exec(text);
  return m ? m[1].toLowerCase() : '';
}

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

/** 从用户输入中提取纯 Tunnel Token（兼容整条 service install 命令） */
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

function makeTunnel() {
  return {
    proc: null,
    running: false,
    starting: false,
    url: '',
    error: '',
    logs: [],
    retries: 0,
    urlTimer: null,
    stopping: false,
    spawnFailed: false,
    raw: '',
  };
}

class CloudflaredManager {
  constructor(options = {}) {
    this.config = { url: 'http://127.0.0.1:3000', token: '', publicUrl: '', cloudflaredPath: '' };
    this.quick = makeTunnel();
    this.token = makeTunnel();
    this.managedByService = false;
    this.serviceStatus = { installed: false, running: false };
    this.onChange = options.onChange || (() => {});
    this._poll = setInterval(() => this.refreshService(), 5000);
  }

  setConfig(patch = {}) {
    this.config = { ...this.config, ...patch };
    if (this.config.token) this.config.token = normalizeToken(this.config.token);
    if (this.config.url && !/^https?:\/\//i.test(this.config.url)) this.config.url = `http://${this.config.url}`;
  }

  resolvedPath() {
    const configured = this.config.cloudflaredPath;
    if (configured) {
      try {
        if (fs.existsSync(configured)) return configured;
      } catch (_) {
        /* ignore */
      }
    }
    return findCloudflared();
  }

  tunnel(kind) {
    return kind === 'token' ? this.token : this.quick;
  }

  logFor(t, line) {
    const text = String(line).trimEnd();
    if (!text) return;
    t.logs.push(text);
    if (t.logs.length > 200) t.logs.shift();
    this.onChange();
  }

  clearUrlTimer(t) {
    if (t.urlTimer) {
      clearTimeout(t.urlTimer);
      t.urlTimer = null;
    }
  }

  async refreshService() {
    const next = await queryCloudflaredService();
    const changed = next.installed !== this.serviceStatus.installed || next.running !== this.serviceStatus.running;
    this.serviceStatus = next;
    if (next.running) {
      if (!this.managedByService) {
        this.managedByService = true;
        this.token.running = true;
        this.logFor(this.token, '检测到 cloudflared 已作为 Windows 系统服务运行，命名隧道由系统托管。');
      }
    } else if (this.managedByService && !this.token.proc) {
      this.managedByService = false;
      this.token.running = false;
    }
    if (changed) this.onChange();
    return this.serviceStatus;
  }

  async start(kind, opts = {}) {
    const t = this.tunnel(kind);

    // 快速隧道与命名隧道互斥：同一时间只允许开启一个，避免两者互相干扰
    // （例如快速隧道的临时地址覆盖命名隧道的固定域名、两个连接器争抢同一个隧道等）。
    const otherKind = kind === 'token' ? 'quick' : 'token';
    if (kind === 'quick' && this.managedByService && !this.token.proc) {
      t.error = '命名隧道正由 Windows 系统服务托管运行。两个隧道不能同时开启，请先在「命名隧道」中卸载系统服务，再启动快速隧道。';
      this.onChange();
      return this.state();
    }
    const other = this.tunnel(otherKind);
    if (other.running || other.proc) {
      this.stop(otherKind);
    }

    if (!opts.auto) t.retries = 0;
    t.stopping = false;
    t.error = '';
    t.url = '';
    t.raw = '';
    t.spawnFailed = false;
    this.clearUrlTimer(t);

    if (kind === 'token') {
      await this.refreshService();
      const token = normalizeToken(this.config.token);
      this.config.token = token;
      if (!token) {
        t.error = '未检测到有效的 Tunnel Token：请粘贴以 eyJ 开头的 Token，或整条 `cloudflared service install eyJ...` 命令。';
        this.onChange();
        return this.state();
      }
      if (this.serviceStatus.running) {
        this.managedByService = true;
        t.running = true;
        this.logFor(t, '命名隧道由 Windows 系统服务托管，运行中。');
        this.onChange();
        return this.state();
      }
    }

    const exe = this.resolvedPath();
    let args;
    if (kind === 'token') {
      args = ['tunnel', 'run', '--token', this.config.token, '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2'];
    } else {
      const target = this.config.url || 'http://127.0.0.1:3000';
      args = ['tunnel', '--url', target, '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2'];
    }
    this.logFor(t, `启动命令：${exe} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

    try {
      t.proc = spawn(exe, args, { windowsHide: true });
    } catch (err) {
      t.error = `无法启动 cloudflared：${err.message}`;
      t.running = false;
      t.starting = false;
      this.onChange();
      return this.state();
    }

    t.running = true;
    t.starting = true;
    this.onChange();

    if (kind === 'quick') {
      t.urlTimer = setTimeout(() => {
        if (t.running && !t.url) {
          t.starting = false;
          this.logFor(t, '尚未获取到公网地址，请检查网络，或点「刷新重建」重试。');
          this.onChange();
        }
      }, QUICK_URL_WAIT_MS);
    }

    const handle = (chunk) => {
      const text = chunk.toString();
      this.logFor(t, text);
      // 日志可能被拆分到多个 chunk，累积一小段再匹配，避免跨块漏掉
      t.raw = (t.raw + text).slice(-8000);

      if (kind === 'quick') {
        const matches = t.raw.match(URL_RE);
        if (matches && matches.length) {
          t.url = matches[matches.length - 1];
          t.starting = false;
          t.retries = 0;
          this.clearUrlTimer(t);
          this.onChange();
        }
        return;
      }

      // 命名隧道：从远端配置日志中解析出固定域名
      const hostname = extractTunnelHostname(t.raw);
      if (hostname) {
        const url = `https://${hostname}`;
        if (t.url !== url) {
          t.url = url;
          t.starting = false;
          this.onChange();
        }
      }
    };
    t.proc.stdout.on('data', handle);
    t.proc.stderr.on('data', handle);

    t.proc.on('error', (err) => {
      t.spawnFailed = true;
      t.error = err && err.code === 'ENOENT'
        ? '未找到 cloudflared，请点击「下载」或用「浏览」指定路径。'
        : `cloudflared 运行错误：${err.message}`;
      t.running = false;
      t.starting = false;
      this.clearUrlTimer(t);
      this.onChange();
    });

    t.proc.on('close', (code) => {
      const hadUrl = !!t.url;
      t.running = false;
      t.starting = false;
      t.proc = null;
      t.url = '';
      t.raw = '';
      this.clearUrlTimer(t);
      if (!t.spawnFailed) {
        if (kind === 'quick' && !t.stopping && t.retries < 3) {
          t.retries += 1;
          t.error = '';
          this.logFor(t, `快速隧道中断，3 秒后自动重建（第 ${t.retries}/3 次）…`);
          setTimeout(() => {
            if (!t.running && !t.stopping) this.start('quick', { auto: true });
          }, 3000);
          return;
        }
        if (kind === 'quick' && t.retries >= 3 && !t.stopping) {
          t.error = '快速隧道多次中断，已停止自动重建，请点击「刷新重建」。';
        } else if (kind === 'token' && code !== 0 && !hadUrl && !t.stopping) {
          t.error = `cloudflared 已退出（退出码 ${code}），请检查 Token 或网络。`;
        }
      }
      this.logFor(t, `cloudflared 已退出，退出码 ${code}`);
    });

    return this.state();
  }

  startQuick(opts) {
    return this.start('quick', opts);
  }

  startToken(opts) {
    return this.start('token', opts);
  }

  stop(kind) {
    const t = this.tunnel(kind);
    t.stopping = true;
    t.starting = false;
    t.retries = 0;
    this.clearUrlTimer(t);
    if (kind === 'token' && this.managedByService && !t.proc) {
      this.logFor(t, '命名隧道由系统服务托管，已停止应用内管理。');
      this.managedByService = false;
      t.running = false;
      t.url = '';
      t.raw = '';
      this.onChange();
      return this.state();
    }
    if (t.proc) {
      const pid = t.proc.pid;
      try {
        if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        else t.proc.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
    t.running = false;
    t.proc = null;
    t.url = '';
    t.raw = '';
    this.onChange();
    return this.state();
  }

  stopQuick() {
    return this.stop('quick');
  }

  stopToken() {
    return this.stop('token');
  }

  async restartQuick() {
    this.stop('quick');
    await new Promise((r) => setTimeout(r, 800));
    return this.start('quick');
  }

  stopAll() {
    this.stop('quick');
    this.stop('token');
  }

  async installService() {
    const token = normalizeToken(this.config.token);
    if (!token) return { ok: false, error: '请先填写 Tunnel Token，再安装为系统服务。' };
    this.config.token = token;
    const result = await runCommand(this.resolvedPath(), ['service', 'install', token]);
    await this.refreshService();
    this.onChange();
    if (!result.ok) return { ok: false, error: `${result.error}\n（安装系统服务通常需要以管理员身份运行本程序）` };
    return { ok: true, output: result.output };
  }

  async uninstallService() {
    const result = await runCommand(this.resolvedPath(), ['service', 'uninstall']);
    await this.refreshService();
    this.onChange();
    if (!result.ok) return { ok: false, error: `${result.error}\n（卸载系统服务通常需要以管理员身份运行本程序）` };
    return { ok: true, output: result.output };
  }

  pubTunnel(t) {
    return {
      running: t.running,
      starting: t.starting,
      url: t.url,
      error: t.error,
      logs: t.logs.slice(-100),
    };
  }

  state() {
    return {
      quick: { ...this.pubTunnel(this.quick), targetUrl: this.config.url },
      token: { ...this.pubTunnel(this.token), token: this.config.token, publicUrl: this.config.publicUrl || '' },
      resolvedPath: this.resolvedPath(),
      cloudflaredPath: this.config.cloudflaredPath,
      managedByService: this.managedByService,
      service: this.serviceStatus,
    };
  }

  dispose() {
    clearInterval(this._poll);
    this.stopAll();
  }
}

module.exports = { CloudflaredManager, findCloudflared, normalizeToken, queryCloudflaredService };
