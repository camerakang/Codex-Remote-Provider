'use strict';
// Orchestration shared by the Electron main process and the CLI.
const fs = require('fs');
const { EventEmitter } = require('events');
const cfg = require('./config');
const remote = require('./remote');
const repair = require('./repair');
const { detectLocalProxy, connectTest, TunnelManager } = require('./proxy');

const isPrivateIp = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Service extends EventEmitter {
  constructor() {
    super();
    this.status = {};
    this.busy = {};
    this.lastResult = {};
    this.repairScans = {};
    this.logs = [];
    this.localProxy = null;
    this.tunnels = new TunnelManager((m, l) => this.log(m, l));
    this.tunnels.on('change', () => this.changed());
  }

  changed() { this.emit('update'); }

  log(msg, level = 'info') {
    const e = { t: Date.now(), level, msg };
    this.logs.push(e);
    if (this.logs.length > 1500) this.logs.splice(0, this.logs.length - 1500);
    try { fs.appendFileSync(cfg.paths.log, `${new Date(e.t).toISOString()} ${level.toUpperCase()} ${msg}\n`); } catch {}
    this.emit('log', e);
  }

  settings() { return cfg.loadSettings(); }

  updateSettings(patch) {
    const s = { ...cfg.loadSettings(), ...patch };
    cfg.saveSettings(s);
    this.changed();
    return s;
  }

  hosts() { return cfg.discoverHosts(); }
  host(name) {
    if (name === repair.LOCAL) return { name, local: true };
    const h = this.hosts().find((x) => x.name === name);
    if (!h) throw new Error(`未知主机 ${name}`);
    return h;
  }
  activeHosts() { const ex = this.settings().excluded || []; return this.hosts().filter((h) => !ex.includes(h.name)); }
  proxyOf(name) { return (this.settings().proxy || {})[name] || { mode: 'off' }; }

  snapshot() {
    const s = this.settings();
    const relays = cfg.listRelays();
    return {
      paths: cfg.paths,
      platform: process.platform,
      local: cfg.publicProfile(cfg.localProfile()),
      relays: relays.map(cfg.publicProfile),
      localProxy: this.localProxy,
      settings: { ...s },
      localRepair: {
        scan: this.repairScans[repair.LOCAL] || null,
        busy: this.busy[repair.LOCAL] || null,
        result: this.lastResult[repair.LOCAL] || null,
      },
      hosts: this.hosts().map((h) => ({
        name: h.name, target: h.target, port: h.port,
        excluded: (s.excluded || []).includes(h.name),
        status: this.status[h.name] ? { ...this.status[h.name], configText: undefined } : null,
        busy: this.busy[h.name] || null,
        result: this.lastResult[h.name] || null,
        repairScan: this.repairScans[h.name] || null,
        proxy: this.proxyOf(h.name),
        tunnel: this.tunnels.state(h.name),
      })),
    };
  }

  async withBusy(name, label, fn) {
    if (this.busy[name]) throw new Error(`${name} 正在执行 ${this.busy[name]}`);
    this.busy[name] = label; this.changed();
    try { return await fn(); } finally { delete this.busy[name]; this.changed(); }
  }

  setResult(name, ok, text) { this.lastResult[name] = { ok, text, t: Date.now() }; this.changed(); }

  async refreshHost(name) {
    const h = this.host(name);
    const st = await remote.status(h);
    this.status[name] = st;
    this.changed();
    return st;
  }

  async refreshAll() {
    await Promise.all(this.hosts().map((h) => this.withBusy(h.name, '检测', () => this.refreshHost(h.name)).catch(() => {})));
  }

  resolveTarget(kind, relayId) {
    if (kind === 'current') {
      const p = cfg.localProfile();
      if (!p) throw new Error('无法解析本机 config.toml');
      if (p.kind === 'aggregate') throw new Error('本机是 Codex++ 聚合模式 (127.0.0.1)，远端无法使用，请选择官方或中转');
      kind = p.kind;
      if (kind === 'relay') relayId = cfg.listRelays()[0]?.id;
    }
    if (kind === 'official') return { kind: 'official', model: null, effort: null };
    const r = cfg.relayById(relayId);
    if (!r) throw new Error('本机和 Codex++ 备份里找不到中转站配置，先在 Codex++ 里切到中转站一次');
    // Aggregate ids ("member/model") only exist behind the local Codex++ proxy.
    if (r.model && r.model.includes('/')) r.model = null;
    return r;
  }

  async switchHosts(names, kind, relayId, { test = false, dryRun = false } = {}) {
    const target = this.resolveTarget(kind, relayId);
    if (target.kind === 'relay') this.updateSettings({ lastRelay: target.id });
    const label = target.kind === 'relay' ? `中转站 ${target.baseUrl}` : '官方登录';
    await Promise.all(names.map((name) => this.withBusy(name, '切换', async () => {
      const h = this.host(name);
      try {
        this.log(`[${name}] 切换到 ${label}${target.model ? `，模型 ${target.model}` : ''}${dryRun ? ' (预演)' : ''}`);
        const r = await remote.switchProvider(h, target, { dryRun });
        if (dryRun) { r.preview.forEach((l) => this.log(`    ${l}`)); this.setResult(name, true, '预演完成'); return; }
        delete this.repairScans[name];
        this.log(`[${name}] 完成，备份 config.toml.bak-${r.stamp}，已重启远端 app-server`, 'ok');
        this.setResult(name, true, `已切到${target.kind === 'relay' ? '中转站' : '官方'}`);
        await this.refreshHost(name).catch(() => {});
        if (test) await this.runTest(name, target.model);
      } catch (e) {
        this.log(`[${name}] ${e.message}`, 'error');
        this.setResult(name, false, e.message);
      }
    })));
  }

  async runTest(name, model) {
    const h = this.host(name);
    if (model === undefined) {
      const st = this.status[name];
      model = st && st.kind === 'relay' && st.model && !st.model.includes('/') ? st.model : null;
    }
    this.log(`[${name}] 实测 codex exec${model ? ` (${model})` : ''} ...`);
    const r = await remote.testCodex(h, model);
    if (r.ok) { this.log(`[${name}] 实测通过: PROVIDER_OK`, 'ok'); this.setResult(name, true, '实测通过'); }
    else {
      this.log(`[${name}] 实测未通过`, 'error');
      r.tail.forEach((l) => this.log(`    ${l}`, 'error'));
      this.setResult(name, false, `实测未通过: ${r.tail[r.tail.length - 1] || ''}`);
    }
    return r;
  }

  async test(name) { return this.withBusy(name, '实测', () => this.runTest(name)); }

  label(name) { return name === repair.LOCAL ? '本机' : name; }

  async scanConversations(name) {
    return this.withBusy(name, '扫描会话', async () => {
      try {
        const result = await repair.scan(this.host(name));
        this.repairScans[name] = result;
        this.changed();
        const outdated = Object.entries(result.database)
          .filter(([provider]) => provider !== result.targetProvider)
          .reduce((sum, [, count]) => sum + count, 0);
        const models = Object.keys(result.models || {}).filter((m) => m !== result.targetModel).length;
        this.log(`[${this.label(name)}] 会话扫描完成：索引中 ${outdated} 条供应商不匹配，会话里出现 ${models} 个其他模型，无法解析的文件 ${result.invalidFiles.length} 个`);
        return result;
      } catch (e) {
        delete this.repairScans[name];
        this.changed();
        this.log(`[${this.label(name)}] 会话扫描失败: ${e.message}`, 'error');
        throw e;
      }
    });
  }

  async repairConversations(name, source, model, resetModel) {
    return this.withBusy(name, '修复会话', async () => {
      try {
        const result = await repair.apply(this.host(name), this.repairScans[name], source, model, resetModel);
        this.log(`[${this.label(name)}] 已修复索引 ${result.database} 条、会话文件 ${result.files} 个；备份: ${result.backup || '无需修改'}`, 'ok');
        this.setResult(name, true, `会话已修复 ${result.database} 条索引 / ${result.files} 个文件`);
        this.repairScans[name] = await repair.scan(this.host(name));
        this.changed();
        return result;
      } catch (e) {
        this.log(`[${this.label(name)}] 会话修复失败: ${e.message}`, 'error');
        this.setResult(name, false, e.message);
        throw e;
      }
    });
  }

  async repairModels(name, sourceModels, targetModel) {
    return this.withBusy(name, '修复模型', async () => {
      try {
        const result = await repair.applyModel(this.host(name), this.repairScans[name], sourceModels, targetModel);
        this.log(`[${this.label(name)}] 已把 ${sourceModels.join('、')} 改为 ${targetModel}：会话文件 ${result.files} 个（${result.lines} 处）、索引 ${result.database} 条；备份: ${result.backup || '无需修改'}`, 'ok');
        this.setResult(name, true, `模型已修复 ${result.files} 个文件 / ${result.database} 条索引`);
        this.repairScans[name] = await repair.scan(this.host(name));
        this.changed();
        return result;
      } catch (e) {
        this.log(`[${this.label(name)}] 模型修复失败: ${e.message}`, 'error');
        this.setResult(name, false, e.message);
        throw e;
      }
    });
  }

  async detectProxy() {
    const s = this.settings();
    const d = await detectLocalProxy(s.localProxyPort);
    d.connect = d.listening ? await connectTest(d.port) : { ok: false, detail: '端口未监听' };
    this.localProxy = d;
    this.changed();
    return d;
  }

  defaultRemotePort(lport) { return lport + 10000 <= 65535 ? lport + 10000 : 17897; }

  async waitTunnel(name, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const st = this.tunnels.state(name).state;
      if (st === 'up') return true;
      await sleep(400);
    }
    return false;
  }

  startTunnel(h, rport, lport) {
    this.tunnels.ensure(h, rport, lport, () => remote.freeRemotePort(h, rport));
  }

  // mode: off | lan | tunnel
  async setProxyMode(name, mode, remotePort) {
    return this.withBusy(name, '代理', async () => {
      const h = this.host(name);
      try {
        const lp = this.localProxy || await this.detectProxy();
        let url = null;
        let rport = Number(remotePort) || this.proxyOf(name).remotePort || this.defaultRemotePort(lp.port);
        if (mode !== 'off' && !lp.listening) throw new Error(`本机代理端口 ${lp.port} 未监听`);
        if (mode === 'lan') {
          const st = this.status[name] && this.status[name].online ? this.status[name] : await this.refreshHost(name);
          if (!st.online) throw new Error('主机离线');
          if (!isPrivateIp(st.client)) throw new Error(`远端看到的本机地址 ${st.client || '?'} 不是局域网地址，请用 SSH 隧道`);
          url = `http://${st.client}:${lp.port}`;
        } else if (mode === 'tunnel') {
          await remote.freeRemotePort(h, rport);
          this.startTunnel(h, rport, lp.port);
          if (!(await this.waitTunnel(name))) {
            const e = this.tunnels.state(name).error || '隧道未能建立';
            this.tunnels.stop(name);
            throw new Error(e);
          }
          url = `http://127.0.0.1:${rport}`;
        } else {
          this.tunnels.stop(name);
        }
        if (url) {
          const t = await remote.testProxy(h, url);
          if (!t.ok) throw new Error(`远端通过 ${url} 访问 chatgpt.com 失败 (${t.detail || t.code})`);
          this.log(`[${name}] 远端经 ${url} 访问 chatgpt.com: HTTP ${t.code}, ${t.ms}ms`, 'ok');
        }
        await remote.setProxy(h, url);
        const all = { ...(this.settings().proxy || {}) };
        all[name] = { mode, remotePort: rport };
        this.updateSettings({ proxy: all });
        this.log(`[${name}] 代理${url ? `已设置为 ${url}` : '已关闭'}，已重启远端 app-server`, 'ok');
        this.setResult(name, true, url ? `代理: ${mode === 'lan' ? '局域网' : '隧道'}` : '代理已关闭');
        await this.refreshHost(name).catch(() => {});
      } catch (e) {
        if (mode === 'tunnel' && this.proxyOf(name).mode !== 'tunnel') this.tunnels.stop(name);
        this.log(`[${name}] ${e.message}`, 'error');
        this.setResult(name, false, e.message);
        throw e;
      }
    });
  }

  async proxyTest(name) {
    return this.withBusy(name, '测速', async () => {
      const h = this.host(name);
      const st = this.status[name] && this.status[name].online ? this.status[name] : await this.refreshHost(name);
      const url = st.proxyBlock || st.appProxy;
      if (!url) { this.setResult(name, false, '未设置代理'); return null; }
      const t = await remote.testProxy(h, url);
      this.log(`[${name}] 经 ${url} 访问 chatgpt.com: ${t.ok ? `HTTP ${t.code}, ${t.ms}ms` : `失败 ${t.detail || t.code}`}`, t.ok ? 'ok' : 'error');
      this.setResult(name, t.ok, t.ok ? `代理可用 ${t.ms}ms` : '代理不可用');
      return t;
    });
  }

  // Bring tunnels back after the app starts.
  async restoreTunnels() {
    const want = this.activeHosts().filter((h) => this.proxyOf(h.name).mode === 'tunnel');
    if (!want.length) return;
    const lp = this.localProxy || await this.detectProxy();
    for (const h of want) {
      const rport = this.proxyOf(h.name).remotePort || this.defaultRemotePort(lp.port);
      this.log(`[${h.name}] 恢复隧道 远端 ${rport} -> 本机 ${lp.port}`);
      remote.freeRemotePort(h, rport).catch(() => {}).then(() => this.startTunnel(h, rport, lp.port));
    }
  }

  shutdown() { this.tunnels.stopAll(); }
}

module.exports = { Service };
