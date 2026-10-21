'use strict';
(() => {
const api = window.api;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<i data-lucide="${n}" class="${cls}"></i>`;

const KIND = {
  official: ['官方', 'k-official'], relay: ['中转站', 'k-relay'], aggregate: ['聚合', 'k-aggregate'],
  offline: ['离线', 'k-offline'], unknown: ['未知', 'k-unknown'], checking: ['检测中', 'k-checking'],
};
const PROXY_MODE = { off: '关闭', lan: '局域网', tunnel: '隧道' };
const TITLES = { hosts: '远端主机', repair: '修复旧对话', proxy: '本地代理', logs: '日志', settings: '设置' };

const ui = {
  page: 'hosts', snap: null, logs: [],
  target: 'official', relayId: null, selected: null, pending: false, repairOptions: {}, modelOptions: {},
};

function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = 'toast'; }, 4200);
}

async function call(ch, ...a) {
  try { return await api.call(ch, ...a); } catch (e) { toast(e.message); return undefined; }
}

function hostKind(h) {
  if (h.busy === '检测' && !h.status) return 'checking';
  if (!h.status) return 'unknown';
  if (!h.status.online) return 'offline';
  return h.status.kind || 'unknown';
}

function relayLabel(r) {
  let host = r.baseUrl;
  try { host = new URL(r.baseUrl).host; } catch {}
  return `${host} · ${r.model || '默认模型'}${r.tokenHint ? ` · ${r.tokenHint}` : ''}`;
}

function selectedNames() {
  return ui.snap.hosts.filter((h) => ui.selected.has(h.name) && !h.excluded).map((h) => h.name);
}

/* ---------- sidebar ---------- */
function renderSide() {
  const s = ui.snap, l = s.local, lp = s.localProxy;
  const [kname] = KIND[l ? l.kind : 'unknown'] || KIND.unknown;
  const tunnels = s.hosts.filter((h) => h.tunnel.state === 'up').length;
  $('#sideStatus').innerHTML = `
    <div class="row">${icon('monitor')}<span>本机</span><span>${esc(kname)} · ${esc(l && l.model || '-')}</span></div>
    <div class="row">${icon('globe')}<span>代理</span><span class="${lp ? (lp.connect && lp.connect.ok ? 'ok-text' : 'err-text') : ''}">${lp ? `:${lp.port} ${lp.connect && lp.connect.ok ? '可用' : '不可用'}` : '检测中'}</span></div>
    <div class="row">${icon('cable')}<span>隧道</span><span>${tunnels} 条运行中</span></div>`;
}

/* ---------- hosts page ---------- */
function hostsActions() {
  const s = ui.snap;
  const relays = s.relays;
  if (!ui.relayId || !relays.some((r) => r.id === ui.relayId)) ui.relayId = (relays.find((r) => r.id === s.settings.lastRelay) || relays[0] || {}).id || null;
  const localUsable = s.local && s.local.kind !== 'aggregate';
  const n = ui.snap ? selectedNames().length : 0;
  return `
    <div class="seg" id="targetSeg">
      <button data-t="official" class="${ui.target === 'official' ? 'on' : ''}">官方</button>
      <button data-t="relay" class="${ui.target === 'relay' ? 'on' : ''}" ${relays.length ? '' : 'disabled'}>中转站</button>
      <button data-t="current" class="${ui.target === 'current' ? 'on' : ''}" ${localUsable ? '' : 'disabled'} title="${localUsable ? '' : '本机为聚合模式'}">同本机</button>
    </div>
    ${ui.target === 'relay' ? `<select id="relaySel">${relays.map((r) => `<option value="${esc(r.id)}" ${r.id === ui.relayId ? 'selected' : ''}>${esc(relayLabel(r))}</option>`).join('')}</select>` : ''}
    <label class="switch"><input type="checkbox" id="testToggle" ${s.settings.testAfterSwitch ? 'checked' : ''}><span class="track"></span>实测</label>
    <button class="icon-btn" id="refreshAll" data-tip="刷新全部">${icon('refresh-cw')}</button>
    <button class="btn primary" id="applyBtn" ${n ? '' : 'disabled'}>${icon('play')}应用到 ${n} 台</button>`;
}

function hostCard(h) {
  const st = h.status, kind = hostKind(h);
  const [kname, kcls] = KIND[kind] || KIND.unknown;
  const sel = ui.selected.has(h.name) && !h.excluded;
  const online = st && st.online;
  const chips = [];
  if (online) {
    chips.push(`<span class="chip">${icon('key-round')}${st.login === 'chatgpt' ? 'ChatGPT 登录' : st.login === 'apikey' ? 'API Key' : '未登录'}</span>`);
    chips.push(`<span class="chip">${icon('cpu')}app-server ${st.appServer ? '运行' : '未运行'}</span>`);
  }
  if (h.proxy.mode !== 'off') {
    const ts = h.proxy.mode === 'tunnel' ? `<span class="dot ${h.tunnel.state === 'stopped' ? 'off' : h.tunnel.state}"></span>` : '';
    chips.push(`<span class="chip">${ts}${icon('globe')}${PROXY_MODE[h.proxy.mode]}</span>`);
  } else if (online && st.appProxy) {
    chips.push(`<span class="chip">${icon('globe')}自有代理</span>`);
  }
  let meta = '';
  if (online) meta = kind === 'relay' || kind === 'aggregate' ? `${st.model || '默认模型'} · ${st.baseUrl}` : (st.model ? `模型 ${st.model}` : '账号默认模型');
  else if (st && st.error) meta = st.error;
  const res = h.result;
  const foot = h.busy
    ? `<span class="busy">${icon('loader-circle', 'spin')}${esc(h.busy)}...</span>`
    : `<span class="result ${res ? (res.ok ? 'ok' : 'err') : ''}" title="${esc(res ? res.text : '')}">${esc(res ? res.text : '')}</span>`;
  const dis = h.busy || !online ? 'disabled' : '';
  return `
    <div class="card ${sel ? 'selected' : ''} ${h.excluded ? 'excluded' : ''}" data-host="${esc(h.name)}">
      <div class="head">
        <button class="check ${sel ? 'on' : ''}" data-act="sel" ${h.excluded ? 'disabled' : ''}>${sel ? icon('check') : ''}</button>
        <div class="names"><div class="title">${esc(h.name)}</div><div class="sub">${esc(h.target)}${h.port ? `:${h.port}` : ''}</div></div>
        <span class="badge ${kcls}">${kname}</span>
      </div>
      <div class="chips">${chips.join('')}</div>
      <div class="meta" title="${esc(meta)}">${esc(meta)}</div>
      <div class="foot">
        ${foot}
        <button class="icon-btn" data-act="official" data-tip="切到官方" ${dis}>${icon('shield-check')}</button>
        <button class="icon-btn" data-act="relay" data-tip="切到中转站" ${dis || (ui.snap.relays.length ? '' : 'disabled')}>${icon('shuffle')}</button>
        <button class="icon-btn" data-act="test" data-tip="实测 codex exec" ${dis}>${icon('flask-conical')}</button>
        <button class="icon-btn" data-act="refresh" data-tip="刷新" ${h.busy ? 'disabled' : ''}>${icon('refresh-cw')}</button>
      </div>
    </div>`;
}

function renderHosts() {
  const hosts = ui.snap.hosts;
  if (!hosts.length) return '<div class="empty">Codex 中没有 SSH 远程连接</div>';
  return `<div class="grid">${hosts.map(hostCard).join('')}</div>`;
}

/* ---------- conversation repair page ---------- */
const LOCAL = '__local__';
const sum = (o) => Object.values(o || {}).reduce((x, y) => x + y, 0);

function providerSection(name, scan, repairable, busy) {
  const counts = [...new Set([...Object.keys(scan.database), ...Object.keys(scan.files)])]
    .filter((p) => p !== scan.targetProvider).sort();
  let option = ui.repairOptions[name];
  if (!option || option.targetProvider !== scan.targetProvider || !counts.includes(option.source)) {
    option = { targetProvider: scan.targetProvider, source: counts.includes('custom') ? 'custom' : counts[0],
      resetModel: true, model: scan.targetModel || '' };
    ui.repairOptions[name] = option;
  }
  const source = option.source;
  const dbCount = source ? scan.database[source] || 0 : 0;
  const fileCount = source ? scan.files[source] || 0 : 0;
  const invalid = scan.invalidFiles.length;
  const opts = counts.map((p) => `<option value="${esc(p)}" ${p === source ? 'selected' : ''}>${esc(p)} · 索引 ${scan.database[p] || 0} / 文件 ${scan.files[p] || 0}</option>`).join('');
  return `<div class="repair-step">供应商不一致</div>
    <div class="repair-controls">
      <label>旧供应商 <select data-act="repair-source" ${counts.length ? '' : 'disabled'}>${opts || '<option>无不匹配记录</option>'}</select></label>
      <label class="switch"><input type="checkbox" data-act="repair-reset" ${option.resetModel ? 'checked' : ''}><span class="track"></span>重置索引模型</label>
      <input type="text" data-act="repair-model" value="${esc(option.model)}" placeholder="留空清除旧索引模型" ${option.resetModel ? '' : 'disabled'}>
    </div>
    <div class="repair-controls">
      <span class="repair-sub">将改为 ${esc(scan.targetProvider)}：索引 ${dbCount} 条、文件 ${fileCount} 个${invalid ? '；存在无法解析的文件，修复已禁用' : ''}</span>
      <button class="btn" data-act="repair-apply" ${!repairable || busy || invalid || !source || dbCount + fileCount === 0 ? 'disabled' : ''}>${icon('wrench')}修复供应商</button>
    </div>`;
}

function modelSection(name, scan, repairable, busy) {
  const all = [...new Set([...Object.keys(scan.models || {}), ...Object.keys(scan.dbModels || {})])].sort();
  let option = ui.modelOptions[name];
  if (!option || option.scanned !== scan) {
    const keep = option ? option.checked : new Set();
    option = { scanned: scan, checked: new Set([...keep].filter((m) => all.includes(m))),
      target: option && option.target ? option.target : (scan.targetModel || '') };
    ui.modelOptions[name] = option;
  }
  const checked = [...option.checked].filter((m) => m !== option.target);
  const files = checked.reduce((n, m) => n + ((scan.models || {})[m] || 0), 0);
  const rows = checked.reduce((n, m) => n + ((scan.dbModels || {})[m] || 0), 0);
  const invalid = scan.invalidFiles.length;
  const boxes = all.map((m) => `<label class="model-chip ${m === option.target ? 'is-target' : ''}">
      <input type="checkbox" data-act="model-pick" value="${esc(m)}" ${option.checked.has(m) && m !== option.target ? 'checked' : ''} ${m === option.target ? 'disabled' : ''}>
      ${esc(m)} <span class="repair-sub">文件 ${(scan.models || {})[m] || 0} / 索引 ${(scan.dbModels || {})[m] || 0}</span></label>`).join('');
  return `<div class="repair-step">旧对话锁定的模型</div>
    <div class="repair-note">旧对话会记住上一轮用的模型。切到另一个登录方式后，Codex 继续对话前会先用这个旧模型压缩上下文，新账号不支持它就会报 “model is not supported”。勾选新登录方式下不可用的模型，统一改成下面的目标模型。</div>
    <div class="model-list">${boxes || '<span class="repair-sub">没有找到模型记录</span>'}</div>
    <div class="repair-controls">
      <label>改为模型 <input type="text" data-act="model-target" value="${esc(option.target)}" placeholder="例如 gpt-6.1-sol"></label>
      <span class="repair-sub">将修改会话文件 ${files} 个、索引 ${rows} 条</span>
      <button class="btn primary" data-act="model-apply" ${!repairable || busy || invalid || !checked.length || !option.target ? 'disabled' : ''}>${icon('wrench')}修复模型</button>
    </div>`;
}

function repairCard({ name, title, sub, repairable, scan, busy, ico }) {
  return `<div class="band repair-host" data-host="${esc(name)}">
    <h2>${icon(ico)}${esc(title)} <span class="repair-sub">${esc(sub)}</span></h2>
    <div class="repair-controls">
      <button class="btn" data-act="repair-scan" ${!repairable || busy ? 'disabled' : ''}>${icon('scan-search')}扫描旧对话</button>
      ${busy ? `<span class="busy">${icon('loader-circle', 'spin')}${esc(busy)}...</span>` : ''}
      ${scan ? `<span class="repair-sub">索引 ${sum(scan.database)} 条；文件 ${sum(scan.files)} 个${scan.invalidFiles.length ? `；无法解析 ${scan.invalidFiles.length} 个` : ''}</span>` : '<span class="repair-sub">尚未扫描</span>'}
    </div>
    ${scan ? modelSection(name, scan, repairable, busy) + providerSection(name, scan, repairable, busy) : ''}
  </div>`;
}

function repairEntry(name) {
  if (name === LOCAL) return { ...ui.snap.localRepair, local: true };
  return ui.snap.hosts.find((h) => h.name === name).repairScan ? { scan: ui.snap.hosts.find((h) => h.name === name).repairScan } : {};
}

function renderRepair() {
  const lr = ui.snap.localRepair || {};
  const intro = `<div class="band">
    <h2>${icon('history')}修复切换登录方式后的旧对话</h2>
    <div class="repair-note">先扫描，再按需修复。修改前自动备份数据库和命中的会话文件到 <code>~/.codex/provider-sync/repair-backups/</code>；对话内容不变，只改记录里的供应商或模型名。</div>
    <div class="repair-note">修复本机前要完全退出 Codex 桌面版（含托盘）；修复远端时会停止远端 app-server，重新连接时 Codex 会自动启动。</div>
  </div>`;
  const local = repairCard({ name: LOCAL, title: '本机', ico: 'monitor',
    sub: lr.scan ? `当前 ${lr.scan.targetProvider}${lr.scan.targetModel ? ' / ' + lr.scan.targetModel : ''}` : '本机 ~/.codex',
    repairable: true, scan: lr.scan, busy: lr.busy });
  const remotes = ui.snap.hosts.map((h) => {
    const st = h.status;
    const online = st && st.online;
    const repairable = online && (st.kind === 'official' || st.kind === 'relay');
    const sub = repairable ? '当前供应商 ' + (h.repairScan ? h.repairScan.targetProvider : st.provider || 'openai') : online ? '供应商配置不可识别' : '离线';
    return repairCard({ name: h.name, title: h.name, ico: 'server', sub, repairable, scan: h.repairScan, busy: h.busy });
  }).join('');
  return intro + local + remotes;
}

/* ---------- proxy page ---------- */
function renderProxy() {
  const s = ui.snap, lp = s.localProxy;
  const c = lp && lp.connect;
  const band = `
    <div class="band">
      <h2>${icon('globe')}本机代理</h2>
      <div class="kv">
        <div><label>端口</label><b>${lp ? lp.port : '-'}</b></div>
        <div><label>来源</label><b>${esc(lp ? lp.source : '检测中')}</b></div>
        <div><label>监听</label><b class="${lp && lp.listening ? 'ok-text' : 'err-text'}">${lp ? (lp.listening ? '是' : '否') : '-'}</b></div>
        <div><label>访问 chatgpt.com</label><b class="${c && c.ok ? 'ok-text' : 'err-text'}" title="${esc(c ? c.detail : '')}">${c ? (c.ok ? `可用 · ${c.ms}ms` : esc(c.detail || '失败')) : '-'}</b></div>
        <div><label>允许局域网</label><b class="${lp && lp.allowLan === false ? 'warn-text' : ''}">${lp ? (lp.allowLan === null ? '未知' : lp.allowLan ? '是' : '否') : '-'}</b></div>
      </div>
      <div class="row-tools">
        <input type="number" id="proxyPort" min="1" max="65535" placeholder="自动" value="${s.settings.localProxyPort || ''}">
        <button class="btn" id="proxyDetect">${icon('radar')}检测</button>
      </div>
    </div>`;
  const rows = s.hosts.map((h) => {
    const st = h.status, online = st && st.online;
    const lanOk = online && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(st.client || '');
    const mode = h.proxy.mode;
    const t = h.tunnel;
    const tunnelCell = mode === 'tunnel'
      ? `<span class="dot ${t.state === 'stopped' ? 'off' : t.state}"></span> ${{ up: '运行中', down: '断开', starting: '连接中', off: '未运行' }[t.state] || t.state}${t.error && t.state !== 'up' ? `<div class="sub err-text">${esc(t.error)}</div>` : ''}`
      : '<span class="sub">-</span>';
    const res = h.result;
    return `
      <tr data-host="${esc(h.name)}">
        <td><b>${esc(h.name)}</b><div class="sub">${esc(h.target)}</div></td>
        <td>${online ? esc(st.client || '-') : `<span class="err-text">${st ? '离线' : '检测中'}</span>`}</td>
        <td><div class="seg small" data-act="mode">
          ${['off', 'lan', 'tunnel'].map((m) => `<button data-m="${m}" class="${mode === m ? 'on' : ''}" ${!online || h.busy || (m === 'lan' && !lanOk) ? 'disabled' : ''}>${PROXY_MODE[m]}</button>`).join('')}
        </div></td>
        <td><input type="number" data-act="rport" min="1024" max="65535" value="${h.proxy.remotePort || (lp ? Math.min(lp.port + 10000, 65535) : '')}" ${mode === 'tunnel' || h.busy ? 'disabled' : ''}></td>
        <td>${tunnelCell}</td>
        <td class="wrap">${online ? esc(st.proxyBlock || st.appProxy || '无') : '-'}</td>
        <td>${h.busy ? `<span class="busy">${icon('loader-circle', 'spin')}${esc(h.busy)}</span>` : `<button class="icon-btn" data-act="ptest" data-tip="测试" ${online ? '' : 'disabled'}>${icon('gauge')}</button>`}</td>
        <td class="wrap"><span class="${res ? (res.ok ? 'ok-text' : 'err-text') : ''}">${esc(res ? res.text : '')}</span></td>
      </tr>`;
  }).join('');
  return `${band}
    <div class="band">
      <h2>${icon('network')}远端使用本机代理</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>主机</th><th>远端看到的本机</th><th>模式</th><th>远端端口</th><th>隧道</th><th>远端生效代理</th><th></th><th>结果</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

/* ---------- logs ---------- */
const fmtTime = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const logLine = (e) => `<div class="log ${e.level}"><time>${fmtTime(e.t)}</time><span>${esc(e.msg)}</span></div>`;
function renderLogs() {
  return `<div class="logs" id="logBox">${ui.logs.length ? ui.logs.map(logLine).join('') : '<div class="empty">暂无日志</div>'}</div>`;
}

/* ---------- settings ---------- */
function renderSettings() {
  const s = ui.snap, st = s.settings;
  const sw = (id, on, label, sub) => `
    <div class="item"><div class="grow"><div>${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <label class="switch"><input type="checkbox" data-set="${id}" ${on ? 'checked' : ''}><span class="track"></span></label></div>`;
  const hosts = s.hosts.map((h) => `
    <div class="item"><div class="grow"><div>${esc(h.name)}</div><div class="sub">${esc(h.target)}${h.port ? `:${h.port}` : ''}</div></div>
    <label class="switch"><input type="checkbox" data-host-incl="${esc(h.name)}" ${h.excluded ? '' : 'checked'}><span class="track"></span></label></div>`).join('');
  const p = s.paths;
  return `
    <div class="band"><h2>${icon('settings')}常规</h2><div class="list">
      ${sw('closeToTray', st.closeToTray, '关闭窗口时驻留托盘', '隧道在程序运行期间保持')}
      ${sw('autostart', st.autostart, '登录时启动 (后台)', '')}
      ${sw('testAfterSwitch', st.testAfterSwitch, '切换后实测 codex exec', '')}
    </div></div>
    <div class="band"><h2>${icon('server')}参与批量操作的主机</h2><div class="list">${hosts || '<div class="empty">无主机</div>'}</div></div>
    <div class="band"><h2>${icon('folder-open')}文件</h2><div class="list">
      <div class="item"><div class="grow"><div>本机 Codex 配置</div><div class="sub">${esc(p.config)}</div></div><button class="icon-btn" data-open="config" data-tip="在文件夹中显示">${icon('folder-open')}</button></div>
      <div class="item"><div class="grow"><div>程序设置与日志</div><div class="sub">${esc(p.stateDir)}</div></div><button class="icon-btn" data-open="dir" data-tip="打开">${icon('folder-open')}</button></div>
    </div></div>`;
}

/* ---------- render ---------- */
function render(force) {
  if (!ui.snap) return;
  // Do not rebuild while the user is typing in a field.
  const a = document.activeElement;
  if (!force && a && a.tagName === 'INPUT' && a.type !== 'checkbox' && $('#content').contains(a)) { ui.pending = true; return; }
  ui.pending = false;
  if (!ui.selected) ui.selected = new Set(ui.snap.hosts.filter((h) => !h.excluded).map((h) => h.name));
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === ui.page));
  $('#pageTitle').textContent = TITLES[ui.page];
  renderSide();
  const actions = {
    hosts: hostsActions,
    repair: () => '',
    proxy: () => `<button class="icon-btn" id="refreshAll" data-tip="刷新全部">${icon('refresh-cw')}</button>`,
    logs: () => `<button class="btn" id="openLog">${icon('folder-open')}日志文件</button><button class="btn" id="clearLog">${icon('trash-2')}清空</button>`,
    settings: () => '',
  }[ui.page]();
  $('#pageActions').innerHTML = actions;
  const scroll = $('#content').scrollTop;
  $('#content').innerHTML = { hosts: renderHosts, repair: renderRepair, proxy: renderProxy, logs: renderLogs, settings: renderSettings }[ui.page]();
  $('#content').scrollTop = ui.page === 'logs' ? $('#content').scrollHeight : scroll;
  window.lucide.createIcons();
}

function hostOf(el) { const c = el.closest('[data-host]'); return c && c.dataset.host; }

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.classList.contains('nav')) { ui.page = b.dataset.page; render(true); return; }
  if (b.parentElement && b.parentElement.id === 'targetSeg') { ui.target = b.dataset.t; render(true); return; }
  if (b.id === 'refreshAll') { call('refresh'); return; }
  if (b.id === 'applyBtn') {
    const names = selectedNames();
    call('switch', names, ui.target, ui.relayId, { test: ui.snap.settings.testAfterSwitch });
    return;
  }
  const repairName = hostOf(b);
  if (b.dataset.act === 'repair-scan' && repairName) { await call('repair:scan', repairName); return; }
  if (b.dataset.act === 'repair-apply' && repairName) {
    const row = b.closest('.repair-host');
    const source = row.querySelector('[data-act=repair-source]').value;
    const model = row.querySelector('[data-act=repair-model]').value.trim();
    const reset = row.querySelector('[data-act=repair-reset]').checked;
    const scan = repairEntry(repairName).scan;
    const label = repairName === LOCAL ? '本机' : repairName;
    if (!window.confirm(`修复 ${label} 的旧对话供应商？\n\n将 ${source} 改为当前供应商 ${scan.targetProvider}；索引 ${scan.database[source] || 0} 条、会话文件 ${scan.files[source] || 0} 个。修复前自动备份。`)) return;
    b.disabled = true;
    await call('repair:apply', repairName, source, model, reset);
    return;
  }
  if (b.dataset.act === 'model-apply' && repairName) {
    const option = ui.modelOptions[repairName];
    const target = option.target;
    const sources = [...option.checked].filter((m) => m !== target);
    const label = repairName === LOCAL ? '本机' : repairName;
    const tip = repairName === LOCAL ? '请确认 Codex 桌面版已完全退出。' : '远端 app-server 会停止，重新连接时启动。';
    if (!window.confirm(`修复 ${label} 旧对话的模型？\n\n${sources.join('\n')}\n→ ${target}\n\n${tip}修复前自动备份。`)) return;
    b.disabled = true;
    await call('repair:model', repairName, sources, target);
    return;
  }
  if (b.id === 'proxyDetect') {
    const v = Number($('#proxyPort').value) || null;
    await call('settings', { localProxyPort: v });
    b.disabled = true; await call('proxy:detect'); return;
  }
  if (b.id === 'clearLog') { await call('logs:clear'); ui.logs = []; render(true); return; }
  if (b.id === 'openLog') { call('open', 'log'); return; }
  if (b.dataset.open) { call('open', b.dataset.open); return; }
  const name = hostOf(b);
  if (!name) return;
  const act = b.dataset.act;
  if (act === 'sel') { ui.selected.has(name) ? ui.selected.delete(name) : ui.selected.add(name); render(true); return; }
  if (act === 'official') { call('switch', [name], 'official', null, { test: ui.snap.settings.testAfterSwitch }); return; }
  if (act === 'relay') { call('switch', [name], 'relay', ui.relayId, { test: ui.snap.settings.testAfterSwitch }); return; }
  if (act === 'test') { call('test', name); return; }
  if (act === 'refresh') { call('refresh', [name]); return; }
  if (act === 'ptest') { call('proxy:test', name); return; }
  if (b.dataset.m) {
    const row = b.closest('tr');
    const rport = Number(row.querySelector('[data-act=rport]').value) || null;
    call('proxy:set', name, b.dataset.m, rport);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.act === 'model-pick' || t.dataset.act === 'model-target') {
    const name = hostOf(t);
    const option = name && ui.modelOptions[name];
    if (option) {
      if (t.dataset.act === 'model-pick') { t.checked ? option.checked.add(t.value) : option.checked.delete(t.value); }
      else option.target = t.value.trim();
      render(true);
    }
    return;
  }
  if (['repair-source', 'repair-reset', 'repair-model'].includes(t.dataset.act)) {
    const name = hostOf(t);
    if (name && ui.repairOptions[name]) {
      ui.repairOptions[name].source = t.closest('.repair-host').querySelector('[data-act=repair-source]').value;
      ui.repairOptions[name].resetModel = t.closest('.repair-host').querySelector('[data-act=repair-reset]').checked;
      ui.repairOptions[name].model = t.closest('.repair-host').querySelector('[data-act=repair-model]').value.trim();
      render(true);
    }
    return;
  }
  if (t.id === 'relaySel') { ui.relayId = t.value; return; }
  if (t.id === 'testToggle') { await call('settings', { testAfterSwitch: t.checked }); return; }
  if (t.dataset.set) { await call('settings', { [t.dataset.set]: t.checked }); return; }
  if (t.dataset.hostIncl) {
    const ex = new Set(ui.snap.settings.excluded || []);
    t.checked ? ex.delete(t.dataset.hostIncl) : ex.add(t.dataset.hostIncl);
    if (t.checked) ui.selected.add(t.dataset.hostIncl);
    await call('settings', { excluded: [...ex] });
  }
});

document.addEventListener('focusout', () => { setTimeout(() => { if (ui.pending) render(); }, 0); });

api.on('update', (s) => { ui.snap = s; render(); });
api.on('log', (e) => {
  ui.logs.push(e);
  if (ui.logs.length > 1500) ui.logs.shift();
  if (ui.page === 'logs') {
    const box = $('#logBox');
    if (box) {
      if (box.querySelector('.empty')) box.innerHTML = '';
      box.insertAdjacentHTML('beforeend', logLine(e));
      $('#content').scrollTop = $('#content').scrollHeight;
    }
  }
  if (e.level === 'error' && ui.page !== 'logs') toast(e.msg);
});

(async () => {
  ui.logs = (await call('logs')) || [];
  ui.snap = await call('snapshot');
  render(true);
})();
})();
