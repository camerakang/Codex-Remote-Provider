'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, nativeTheme } = require('electron');
const path = require('path');
const { Service } = require('./core/service');

if (process.env.CRP_CAPTURE) {
  const captureProfile = path.join(process.env.CRP_CAPTURE, 'profile');
  require('fs').mkdirSync(captureProfile, { recursive: true });
  app.setPath('userData', captureProfile);
}
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const svc = new Service();
let win = null, tray = null, quitting = false, pushTimer = null;
const startHidden = process.argv.includes('--hidden');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

svc.on('update', () => {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { send('update', svc.snapshot()); updateTray(); }, 80);
});
svc.on('log', (e) => send('log', e));

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 980, minHeight: 640,
    show: false, backgroundColor: '#1b1c22', title: 'Codex Remote Provider',
    icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => {
    if (!quitting && svc.settings().closeToTray) {
      e.preventDefault(); win.hide();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') svc.log(`[界面] ${e.message} (${e.sourceId}:${e.lineNumber})`, 'error');
  });
}

function updateTray() {
  if (!tray) return;
  const s = svc.snapshot();
  const relay = s.relays.find((r) => r.id === s.settings.lastRelay) || s.relays[0];
  const names = svc.activeHosts().map((h) => h.name);
  const up = Object.values(svc.tunnels.all()).filter((t) => t.state === 'up').length;
  tray.setToolTip(`Codex Remote Provider${up ? ` · ${up} 条隧道` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showWindow },
    { type: 'separator' },
    { label: '全部远端切到官方登录', click: () => svc.switchHosts(names, 'official').catch(() => {}) },
    { label: `全部远端切到中转站${relay ? ` (${new URL(relay.baseUrl).host})` : ''}`, enabled: !!relay, click: () => svc.switchHosts(names, 'relay', relay && relay.id).catch(() => {}) },
    { label: '刷新远端状态', click: () => svc.refreshAll() },
    { type: 'separator' },
    { label: '退出 (关闭所有隧道)', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  let img = nativeImage.createFromPath(iconPath).resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

handle('snapshot', () => svc.snapshot());
handle('logs', () => svc.logs);
handle('refresh', (names) => (names && names.length
  ? Promise.all(names.map((n) => svc.withBusy(n, '检测', () => svc.refreshHost(n)).catch(() => {})))
  : svc.refreshAll()));
handle('switch', (names, kind, relayId, opts) => svc.switchHosts(names, kind, relayId, opts || {}));
handle('test', (name) => svc.test(name));
handle('repair:scan', (name) => svc.scanConversations(name));
handle('repair:apply', (name, source, model, resetModel) => svc.repairConversations(name, source, model, resetModel));
handle('repair:reasoning', (name, scope) => svc.repairReasoning(name, scope));
handle('repair:model', (name, sourceModels, targetModel) => svc.repairModels(name, sourceModels, targetModel));
handle('proxy:detect', () => svc.detectProxy());
handle('proxy:set', (name, mode, rport) => svc.setProxyMode(name, mode, rport));
handle('proxy:test', (name) => svc.proxyTest(name));
handle('settings', (patch) => {
  const s = svc.updateSettings(patch);
  if ('autostart' in patch) {
    app.setLoginItemSettings({ openAtLogin: !!patch.autostart, openAsHidden: true, args: ['--hidden'] });
  }
  return s;
});
handle('logs:clear', () => { svc.logs.length = 0; });
handle('open', (which) => {
  const p = which === 'log' ? svc.snapshot().paths.log : which === 'config' ? svc.snapshot().paths.config : svc.snapshot().paths.stateDir;
  return which === 'dir' ? shell.openPath(p) : shell.showItemInFolder(p);
});

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; svc.shutdown(); });
app.on('window-all-closed', () => { if (!svc.settings().closeToTray) app.quit(); });

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    if (startHidden && app.dock) app.dock.hide();
  } else {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  createTray();
  svc.log(`启动 v${app.getVersion()} (${process.platform})`);
  svc.detectProxy().then(() => { if (!process.env.CRP_CAPTURE) svc.restoreTunnels(); })
    .catch((e) => svc.log(`代理检测失败: ${e.message}`, 'error'));
  svc.refreshAll();
  if (process.env.CRP_CAPTURE) captureAll(process.env.CRP_CAPTURE);
});

// Dev aid: CRP_CAPTURE=<dir> saves a screenshot of every page, then quits.
async function captureAll(dir) {
  const fs = require('fs');
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(Number(process.env.CRP_CAPTURE_WAIT || 12000));
  for (const page of ['hosts', 'repair', 'proxy', 'logs', 'settings']) {
    await win.webContents.executeJavaScript(`document.querySelector('.nav[data-page=${page}]').click()`);
    if (page === 'repair') {
      await svc.scanConversations('__local__').catch(() => {});
      const host = svc.activeHosts().find((h) => h.name === 'forlinx');
      if (host) await svc.scanConversations(host.name).catch(() => {});
      await wait(500);
      if (process.env.CRP_CAPTURE_TARGET) {
        await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('[data-act=model-target]'); if (s) { s.value = [...s.options].map((x) => x.value).filter((v) => v.endsWith('|' + ${JSON.stringify(process.env.CRP_CAPTURE_TARGET)})).pop() || s.value; s.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
        await wait(300);
      }
      await win.webContents.executeJavaScript(`(document.querySelector('[data-act=${process.env.CRP_CAPTURE_PICK || 'model-unsupported'}]') || {click() {}}).click()`);
      if (process.env.CRP_CAPTURE_SCROLL) {
        await wait(300);
        await win.webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(process.env.CRP_CAPTURE_SCROLL)}) || {scrollIntoView() {}}).scrollIntoView({ block: 'center' })`);
      }
    }
    await wait(700);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${page}.png`), img.toPNG());
  }
  quitting = true; app.quit();
}
