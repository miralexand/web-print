'use strict';

const { createApp, reactive, ref, computed, onMounted } = Vue;
const { ElMessage } = ElementPlus;

const app = createApp({
  setup() {
    const tab = ref('overview');
    const initialized = ref(false);
    const tutorialOpen = ref(false);

    const nav = [
      { key: 'overview', label: '概览', icon: '🌿' },
      { key: 'printers', label: '打印机', icon: '🖨️' },
      { key: 'tunnel', label: 'Cloudflare 隧道', icon: '☁️' },
      { key: 'settings', label: '设置', icon: '⚙️' },
      { key: 'about', label: '关于', icon: 'ℹ️' },
    ];

    const state = reactive({
      running: false,
      host: '127.0.0.1',
      port: 8081,
      token: '',
      autoStart: false,
      portable: false,
      dataDir: '',
      logs: [],
      web: { running: false, host: '127.0.0.1', port: 3000, url: '', adminUser: 'admin', allowLan: false, lanUrls: [] },
      about: {},
    });

    const tunnel = reactive({
      resolvedPath: '',
      cloudflaredPath: '',
      managedByService: false,
      disclaimerDontRemind: false,
      service: { installed: false, running: false },
      quick: { running: false, starting: false, url: '', error: '', logs: [], targetUrl: 'http://127.0.0.1:3000' },
      token: { running: false, starting: false, url: '', error: '', logs: [], token: '' },
    });

    const disclaimer = reactive({ show: false, dontRemind: false, resolve: null });
    const update = reactive({ show: false, checking: false, current: '', latest: '', notes: '', releaseUrl: '', setupUrl: '', zipUrl: '', installing: false, error: '' });

    const printers = ref([]);
    const busy = reactive({ service: false, web: false, printers: false, tunnel: false, download: false });
    const serviceForm = reactive({ port: 8081, webPort: 3000, allowLan: true, token: '', agentBasePath: '', autoStart: false });
    const quickForm = reactive({ url: 'http://127.0.0.1:3000', autoStart: false });
    const tokenForm = reactive({ token: '', publicUrl: '', autoStart: false });

    const serviceLogs = computed(() => (state.logs || []).join('\n'));
    const quickLogs = computed(() => (tunnel.quick.logs || []).join('\n'));
    const tokenLogs = computed(() => (tunnel.token.logs || []).join('\n'));
    const coreRunning = computed(() => state.web.running && state.running);
    const cloudflaredMissing = computed(() => !tunnel.resolvedPath || tunnel.resolvedPath === 'cloudflared');
    const hasSavedToken = computed(() => !!tunnel.token.token);
    const maskedSavedToken = computed(() => {
      const t = tunnel.token.token || '';
      if (!t) return '';
      return t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
    });

    function initForms(s) {
      serviceForm.port = s.port;
      serviceForm.webPort = s.web ? s.web.port : 3000;
      serviceForm.allowLan = s.web ? !!s.web.allowLan : true;
      serviceForm.token = s.token || '';
      serviceForm.agentBasePath = s.basePath || '';
      serviceForm.autoStart = !!s.autoStart;
      if (s.cloudflare) {
        quickForm.url = (s.cloudflare.quick && s.cloudflare.quick.targetUrl) || 'http://127.0.0.1:3000';
        quickForm.autoStart = !!s.cloudflare.autoQuick;
        tokenForm.token = (s.cloudflare.token && s.cloudflare.token.token) || '';
        tokenForm.publicUrl = (s.cloudflare.token && s.cloudflare.token.publicUrl) || '';
        tokenForm.autoStart = !!s.cloudflare.autoToken;
      }
    }

    function syncState(s) {
      if (!s) return;
      state.running = s.running;
      state.host = s.host;
      state.port = s.port;
      state.token = s.token;
      state.autoStart = s.autoStart;
      state.portable = s.portable;
      state.dataDir = s.dataDir;
      state.logs = s.logs || [];
      if (s.web) Object.assign(state.web, s.web);
      if (s.about) state.about = s.about;
      if (s.cloudflare) {
        tunnel.resolvedPath = s.cloudflare.resolvedPath;
        tunnel.cloudflaredPath = s.cloudflare.cloudflaredPath;
        tunnel.managedByService = s.cloudflare.managedByService;
        tunnel.disclaimerDontRemind = !!s.cloudflare.disclaimerDontRemind;
        tunnel.service = s.cloudflare.service || { installed: false, running: false };
        if (s.cloudflare.quick) Object.assign(tunnel.quick, s.cloudflare.quick);
        if (s.cloudflare.token) Object.assign(tunnel.token, s.cloudflare.token);
      }
      if (!initialized.value) {
        initForms(s);
        initialized.value = true;
      }
    }

    async function refresh() {
      syncState(await window.trayApi.getState());
    }

    async function refreshAll() {
      await refresh();
      await loadPrinters();
    }

    async function loadPrinters() {
      busy.printers = true;
      try {
        const res = await window.trayApi.getPrinters();
        printers.value = res.ok ? res.printers || [] : [];
        if (!res.ok) ElMessage.error(res.error || '获取打印机失败');
      } finally {
        busy.printers = false;
      }
    }

    async function toggleService() {
      busy.service = true;
      try {
        const res = state.running ? await window.trayApi.stop() : await window.trayApi.start();
        if (res && res.state) syncState(res.state);
        if (res && res.ok === false) ElMessage.error(res.error);
        else ElMessage.success(state.running ? '打印服务已启动' : '打印服务已停止');
      } finally {
        busy.service = false;
      }
    }

    async function toggleWeb() {
      busy.web = true;
      try {
        const res = state.web.running ? await window.trayApi.webStop() : await window.trayApi.webStart();
        if (res && res.state) syncState(res.state);
        if (res && res.ok === false) ElMessage.error(res.error);
        else ElMessage.success(state.web.running ? 'Web 服务已启动' : 'Web 服务已停止');
      } finally {
        busy.web = false;
      }
    }

    async function saveService() {
      busy.service = true;
      try {
        const res = await window.trayApi.saveConfig({ ...serviceForm });
        if (res.ok) {
          syncState(res.state);
          initialized.value = true;
          ElMessage.success('设置已保存');
        } else {
          ElMessage.error(res.error || '保存失败');
        }
      } finally {
        busy.service = false;
      }
    }

    function askDisclaimer() {
      if (tunnel.disclaimerDontRemind) return Promise.resolve(true);
      return new Promise((resolve) => {
        disclaimer.dontRemind = false;
        disclaimer.resolve = resolve;
        disclaimer.show = true;
      });
    }

    function disclaimerConfirm() {
      const resolve = disclaimer.resolve;
      disclaimer.resolve = null;
      disclaimer.show = false;
      if (disclaimer.dontRemind) {
        window.trayApi.tunnelAcceptDisclaimer().then((res) => {
          if (res && res.state) syncState(res.state);
        });
      }
      if (resolve) resolve(true);
    }

    function disclaimerCancel() {
      const resolve = disclaimer.resolve;
      disclaimer.resolve = null;
      disclaimer.show = false;
      if (resolve) resolve(false);
    }

    async function ensureCloudflaredDownloaded() {
      if (!cloudflaredMissing.value) return true;
      ElMessage.info('未找到 cloudflared，正在自动下载…');
      const dl = await window.trayApi.tunnelDownload();
      if (dl && dl.state) syncState(dl.state);
      if (!dl || !dl.ok) {
        ElMessage.error((dl && dl.error) || 'cloudflared 下载失败');
        return false;
      }
      ElMessage.success(`cloudflared 下载完成（来源：${dl.source || '官方'}）`);
      return true;
    }

    // ---------- 快速隧道 ----------
    async function saveQuickConfig(start) {
      if (start && !(await askDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (start && !(await ensureCloudflaredDownloaded())) return;
        const res = await window.trayApi.tunnelSave({ url: quickForm.url, autoQuick: quickForm.autoStart });
        if (res && res.state) syncState(res.state);
        if (start) {
          const started = await window.trayApi.quickStart();
          if (started && started.state) syncState(started.state);
          ElMessage.success('快速隧道已启动，正在获取公网地址…');
        } else {
          ElMessage.success('快速隧道配置已保存');
        }
      } finally {
        busy.tunnel = false;
      }
    }

    async function startQuickTunnel() {
      if (!(await askDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (!(await ensureCloudflaredDownloaded())) return;
        const res = await window.trayApi.tunnelSave({ url: quickForm.url, autoQuick: quickForm.autoStart });
        if (res && res.state) syncState(res.state);
        const started = await window.trayApi.quickStart();
        if (started && started.state) syncState(started.state);
      } finally {
        busy.tunnel = false;
      }
    }

    async function oneClickPublic() {
      if (!(await askDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (!(await ensureCloudflaredDownloaded())) return;
        quickForm.url = quickForm.url || `http://127.0.0.1:${state.web.port}`;
        const saved = await window.trayApi.tunnelSave({ url: quickForm.url, autoQuick: quickForm.autoStart });
        if (saved && saved.state) syncState(saved.state);
        const started = await window.trayApi.quickStart();
        if (started && started.state) syncState(started.state);
        const q = started && started.state && started.state.cloudflare && started.state.cloudflare.quick;
        if (q && q.error) ElMessage.error(q.error);
        else ElMessage.success('已开启公网访问，正在获取地址…');
      } finally {
        busy.tunnel = false;
      }
    }

    async function stopQuickTunnel() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.quickStop();
        if (res && res.state) syncState(res.state);
        ElMessage.success('快速隧道已停止');
      } finally {
        busy.tunnel = false;
      }
    }

    async function restartQuickTunnel() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.quickRestart();
        if (res && res.state) syncState(res.state);
        ElMessage.success('正在重建快速隧道，稍候将生成新的公网地址…');
      } finally {
        busy.tunnel = false;
      }
    }

    // ---------- 命名隧道 ----------
    async function saveNamedConfig(start) {
      if (start && !(await askDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (start && !(await ensureCloudflaredDownloaded())) return;
        const res = await window.trayApi.tunnelSave({ token: tokenForm.token, autoToken: tokenForm.autoStart, publicUrl: tokenForm.publicUrl });
        if (res && res.state) syncState(res.state);
        if (start) {
          const started = await window.trayApi.tokenStart();
          if (started && started.state) syncState(started.state);
          const t = started && started.state && started.state.cloudflare && started.state.cloudflare.token;
          if (t && t.error) ElMessage.error(t.error);
          else ElMessage.success('命名隧道已启动');
        } else {
          ElMessage.success('命名隧道配置已保存，下次打开自动带出');
        }
      } finally {
        busy.tunnel = false;
      }
    }

    async function startNamedTunnel() {
      if (!(await askDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (!(await ensureCloudflaredDownloaded())) return;
        const res = await window.trayApi.tunnelSave({ token: tokenForm.token, autoToken: tokenForm.autoStart, publicUrl: tokenForm.publicUrl });
        if (res && res.state) syncState(res.state);
        const started = await window.trayApi.tokenStart();
        if (started && started.state) syncState(started.state);
      } finally {
        busy.tunnel = false;
      }
    }

    async function stopNamedTunnel() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tokenStop();
        if (res && res.state) syncState(res.state);
        ElMessage.success('命名隧道已停止');
      } finally {
        busy.tunnel = false;
      }
    }

    async function clearTokenConfig() {
      if (!window.confirm('确定清除已保存的命名隧道配置（Token）吗？')) return;
      busy.tunnel = true;
      try {
        if (tunnel.token.running) {
          try {
            await window.trayApi.tokenStop();
          } catch (_) {
            /* ignore */
          }
        }
        const res = await window.trayApi.tunnelSave({ token: '' });
        if (res && res.state) syncState(res.state);
        tokenForm.token = '';
        ElMessage.success('已清除已保存的配置');
      } finally {
        busy.tunnel = false;
      }
    }

    async function pickCloudflared() {
      const res = await window.trayApi.tunnelPick();
      if (res.ok) {
        const saved = await window.trayApi.tunnelSave({ cloudflaredPath: res.path });
        if (saved && saved.state) syncState(saved.state);
        ElMessage.success('已设置 cloudflared 路径');
      }
    }

    async function installService() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tunnelServiceInstall();
        if (res.state) syncState(res.state);
        if (res.ok) ElMessage.success('已安装为 Windows 系统服务并启动');
        else ElMessage.error(res.error || '安装失败');
      } finally {
        busy.tunnel = false;
      }
    }

    async function uninstallService() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tunnelServiceUninstall();
        if (res.state) syncState(res.state);
        if (res.ok) ElMessage.success('已卸载 Windows 系统服务');
        else ElMessage.error(res.error || '卸载失败');
      } finally {
        busy.tunnel = false;
      }
    }

    async function downloadCloudflared() {
      busy.download = true;
      ElMessage.info('开始下载 cloudflared…');
      try {
        const res = await window.trayApi.tunnelDownload();
        if (res.ok) {
          if (res.state) syncState(res.state);
          ElMessage.success('cloudflared 下载完成');
        } else {
          ElMessage.error(res.error || '下载失败');
        }
      } finally {
        busy.download = false;
      }
    }

    function openWeb() {
      window.trayApi.openWeb();
    }

    async function checkUpdate() {
      update.checking = true;
      try {
        const res = await window.trayApi.checkUpdate();
        if (!res || !res.ok) {
          ElMessage.error(`检查更新失败：${(res && res.error) || '未知错误'}`);
          return;
        }
        if (!res.hasUpdate) {
          ElMessage.success(`已是最新版本 v${res.current}`);
          return;
        }
        Object.assign(update, {
          show: true,
          current: res.current,
          latest: res.latest,
          notes: res.notes || '',
          releaseUrl: res.releaseUrl,
          setupUrl: res.setupUrl || '',
          zipUrl: res.zipUrl || '',
          error: '',
        });
      } finally {
        update.checking = false;
      }
    }

    async function updateNow() {
      update.error = '';
      update.installing = true;
      try {
        const res = await window.trayApi.installUpdate({ setupUrl: update.setupUrl, zipUrl: update.zipUrl });
        if (!res || !res.ok) {
          update.error = (res && res.error) || '更新失败';
          return;
        }
        ElMessage.success('更新已开始，应用将自动重启，请稍候…');
      } finally {
        update.installing = false;
      }
    }

    function updateLater() {
      update.show = false;
    }

    function openReleasePage() {
      if (update.releaseUrl) openExternal(update.releaseUrl);
      update.show = false;
    }

    function openDownloadPage() {
      window.trayApi.tunnelOpenDownload();
    }

    function openCloudflareConsole() {
      window.trayApi.openExternal('https://one.dash.cloudflare.com/');
    }

    function openExternal(url) {
      if (url) window.trayApi.openExternal(url);
    }

    function hideToTray() {
      window.trayApi.hide();
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        ElMessage.success('已复制');
      } catch (_) {
        ElMessage.warning('复制失败，请手动选择');
      }
    }

    onMounted(() => {
      refreshAll();
      window.trayApi.onStateChanged(syncState);
      setInterval(refresh, 3000);
    });

    return {
      tab,
      nav,
      tutorialOpen,
      state,
      tunnel,
      disclaimer,
      disclaimerConfirm,
      disclaimerCancel,
      update,
      printers,
      busy,
      serviceForm,
      quickForm,
      tokenForm,
      serviceLogs,
      quickLogs,
      tokenLogs,
      coreRunning,
      cloudflaredMissing,
      hasSavedToken,
      maskedSavedToken,
      refresh,
      refreshAll,
      loadPrinters,
      toggleService,
      toggleWeb,
      saveService,
      saveQuickConfig,
      startQuickTunnel,
      oneClickPublic,
      stopQuickTunnel,
      restartQuickTunnel,
      saveNamedConfig,
      startNamedTunnel,
      stopNamedTunnel,
      clearTokenConfig,
      pickCloudflared,
      installService,
      uninstallService,
      downloadCloudflared,
      openWeb,
      openDownloadPage,
      openCloudflareConsole,
      openExternal,
      checkUpdate,
      updateNow,
      updateLater,
      openReleasePage,
      hideToTray,
      copyText,
    };
  },
});

app.use(ElementPlus);
app.mount('#app');
