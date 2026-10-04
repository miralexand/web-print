'use strict';

const { createApp, reactive, ref, computed, onMounted } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;

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
      sofficePath: '',
      sofficeFound: false,
      autoStart: false,
      portable: false,
      dataDir: '',
      logs: [],
      web: { running: false, host: '127.0.0.1', port: 3000, url: '', adminUser: 'admin', allowLan: false, lanUrls: [] },
      about: {},
    });

    const tunnel = reactive({
      running: false,
      starting: false,
      url: '',
      error: '',
      logs: [],
      mode: 'quick',
      targetUrl: 'http://127.0.0.1:3000',
      token: '',
      cloudflaredPath: '',
      resolvedPath: '',
      managedByService: false,
      quickDisclaimerAccepted: false,
      service: { installed: false, running: false },
    });

    const printers = ref([]);
    const busy = reactive({ service: false, web: false, printers: false, tunnel: false, download: false });
    const serviceForm = reactive({ port: 8081, webPort: 3000, allowLan: true, token: '', agentBasePath: '', sofficePath: '', autoStart: false });
    const tunnelForm = reactive({ mode: 'quick', url: 'http://127.0.0.1:3000', token: '', cloudflaredPath: '', autoStart: false });

    const serviceLogs = computed(() => (state.logs || []).join('\n'));
    const tunnelLogs = computed(() => (tunnel.logs || []).join('\n'));
    const tunnelRunning = computed(() => tunnel.running);
    const allRunning = computed(() => state.web.running && state.running);

    function initForms(s) {
      serviceForm.port = s.port;
      serviceForm.webPort = s.web ? s.web.port : 3000;
      serviceForm.allowLan = s.web ? !!s.web.allowLan : true;
      serviceForm.token = s.token || '';
      serviceForm.agentBasePath = s.basePath || '';
      serviceForm.sofficePath = s.sofficePath || '';
      serviceForm.autoStart = !!s.autoStart;
      if (s.cloudflare) {
        tunnelForm.mode = s.cloudflare.mode || 'quick';
        tunnelForm.url = s.cloudflare.targetUrl || 'http://127.0.0.1:3000';
        tunnelForm.token = s.cloudflare.token || '';
        tunnelForm.cloudflaredPath = s.cloudflare.cloudflaredPath || '';
        tunnelForm.autoStart = !!s.cloudflare.autoStart;
      }
    }

    function syncState(s) {
      if (!s) return;
      state.running = s.running;
      state.host = s.host;
      state.port = s.port;
      state.token = s.token;
      state.sofficePath = s.sofficePath;
      state.sofficeFound = !!s.sofficeFound;
      state.autoStart = s.autoStart;
      state.portable = s.portable;
      state.dataDir = s.dataDir;
      state.logs = s.logs || [];
      if (s.web) Object.assign(state.web, s.web);
      if (s.about) state.about = s.about;
      if (s.cloudflare) {
        tunnel.running = s.cloudflare.running;
        tunnel.starting = !!s.cloudflare.starting;
        tunnel.url = s.cloudflare.url;
        tunnel.error = s.cloudflare.error;
        tunnel.logs = s.cloudflare.logs || [];
        tunnel.mode = s.cloudflare.mode;
        tunnel.targetUrl = s.cloudflare.targetUrl;
        tunnel.token = s.cloudflare.token;
        tunnel.cloudflaredPath = s.cloudflare.cloudflaredPath;
        tunnel.resolvedPath = s.cloudflare.resolvedPath;
        tunnel.managedByService = s.cloudflare.managedByService;
        tunnel.quickDisclaimerAccepted = !!s.cloudflare.quickDisclaimerAccepted;
        tunnel.service = s.cloudflare.service || { installed: false, running: false };
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

    async function ensureQuickDisclaimer() {
      if (tunnelForm.mode !== 'quick' || tunnel.quickDisclaimerAccepted) return true;
      try {
        await ElMessageBox.confirm(
          '快速隧道由 Cloudflare 免费提供，公网地址随机且不固定，可能随时失效、中断或无法访问，可用性不作任何保证。请勿用于机密或敏感文件。因使用快速隧道产生的任何风险与后果，均由使用者自行承担。',
          '快速隧道免责声明',
          { confirmButtonText: '我已阅读并同意', cancelButtonText: '取消', type: 'warning', dangerouslyUseHTMLString: false }
        );
      } catch (_) {
        return false;
      }
      const res = await window.trayApi.tunnelAcceptDisclaimer();
      if (res && res.state) syncState(res.state);
      return true;
    }

    async function saveTunnel(start) {
      if (start && !(await ensureQuickDisclaimer())) return;
      busy.tunnel = true;
      try {
        if (start) await window.trayApi.tunnelStop();
        const res = await window.trayApi.tunnelSave({ ...tunnelForm });
        if (!res.ok) {
          ElMessage.error(res.error || '保存失败');
          return;
        }
        if (start) {
          const started = await window.trayApi.tunnelStart();
          if (started && started.state) syncState(started.state);
          ElMessage.success('隧道已启动，正在获取公网地址…');
        } else {
          syncState(res.state);
          ElMessage.success('隧道配置已保存');
        }
      } finally {
        busy.tunnel = false;
      }
    }

    async function startTunnel() {
      if (!(await ensureQuickDisclaimer())) return;
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tunnelStart();
        if (res && res.state) syncState(res.state);
      } finally {
        busy.tunnel = false;
      }
    }

    async function stopTunnel() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tunnelStop();
        if (res && res.state) syncState(res.state);
        ElMessage.success('隧道已停止');
      } finally {
        busy.tunnel = false;
      }
    }

    async function restartTunnel() {
      busy.tunnel = true;
      try {
        const res = await window.trayApi.tunnelRestart();
        if (res && res.state) syncState(res.state);
        ElMessage.success('正在重建隧道，稍候将生成新的公网地址…');
      } finally {
        busy.tunnel = false;
      }
    }

    async function pickCloudflared() {
      const res = await window.trayApi.tunnelPick();
      if (res.ok) tunnelForm.cloudflaredPath = res.path;
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

    async function pickSoffice() {
      const res = await window.trayApi.pickSoffice();
      if (res.ok) serviceForm.sofficePath = res.path;
    }

    async function downloadCloudflared() {
      busy.download = true;
      ElMessage.info('开始下载 cloudflared…');
      try {
        const res = await window.trayApi.tunnelDownload();
        if (res.ok) {
          tunnelForm.cloudflaredPath = res.path;
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
    function openDownloadPage() {
      window.trayApi.tunnelOpenDownload();
    }
    function openExternal(url) {
      if (url) window.trayApi.openExternal(url);
    }
    function hideToTray() {
      window.trayApi.hide();
    }

    async function copyUrl() {
      try {
        await navigator.clipboard.writeText(tunnel.url);
        ElMessage.success('已复制公网地址');
      } catch (_) {
        ElMessage.warning('复制失败，请手动选择');
      }
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
      printers,
      busy,
      serviceForm,
      tunnelForm,
      serviceLogs,
      tunnelLogs,
      tunnelRunning,
      allRunning,
      refresh,
      refreshAll,
      loadPrinters,
      toggleService,
      toggleWeb,
      saveService,
      saveTunnel,
      startTunnel,
      stopTunnel,
      restartTunnel,
      pickCloudflared,
      pickSoffice,
      installService,
      uninstallService,
      downloadCloudflared,
      openWeb,
      openDownloadPage,
      openExternal,
      hideToTray,
      copyUrl,
      copyText,
    };
  },
});

app.use(ElementPlus);
app.mount('#app');
