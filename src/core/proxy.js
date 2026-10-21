'use strict';
// Local proxy detection (Clash Verge / mihomo / system proxy) and reverse tunnels
// that let remote hosts use it.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { spawnTunnel } = require('./ssh');

function clashDirs() {
  const ids = ['io.github.clash-verge-rev.clash-verge-rev', 'io.github.clash-verge-rev.clash-verge-rev.dev', 'clash-verge'];
  const bases = process.platform === 'win32'
    ? [process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')]
    : process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support')]
      : [path.join(os.homedir(), '.local', 'share'), path.join(os.homedir(), '.config')];
  const out = [];
  for (const b of bases) for (const id of ids) out.push(path.join(b, id));
  out.push(path.join(os.homedir(), '.config', 'clash'), path.join(os.homedir(), '.config', 'mihomo'));
  return out.filter((d) => fs.existsSync(d));
}

function yamlNum(text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*(\\d+)', 'm'));
  return m ? Number(m[1]) : null;
}

function systemProxyPort() {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const m = (process.env[k] || '').match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/);
    if (m) return { port: Number(m[1]), source: `环境变量 ${k}` };
  }
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+(?:[^\r\n]*?)(?:127\.0\.0\.1|localhost):(\d+)/);
        if (m) return { port: Number(m[1]), source: '系统代理' };
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
      if (/HTTPSEnable : 1/.test(out)) {
        const m = out.match(/HTTPSPort : (\d+)/);
        if (m) return { port: Number(m[1]), source: '系统代理' };
      }
    }
  } catch {}
  return null;
}

function isListening(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// HTTP CONNECT through the local proxy; proves it forwards, not just listens.
function connectTest(port, target = 'chatgpt.com:443', timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    const done = (ok, detail) => { s.destroy(); resolve({ ok, ms: Date.now() - t0, detail }); };
    s.setTimeout(timeout, () => done(false, '超时'));
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (d) => {
      buf += d;
      const line = buf.split('\r\n')[0];
      if (buf.includes('\r\n')) done(/^HTTP\/1\.[01] 200/.test(line), line);
    });
    s.on('error', (e) => done(false, e.message));
  });
}

async function detectLocalProxy(manualPort) {
  const cands = [];
  if (manualPort) cands.push({ port: Number(manualPort), source: '手动设置' });
  let allowLan = null;
  for (const d of clashDirs()) {
    for (const f of ['config.yaml', 'clash-verge.yaml']) {
      try {
        const t = fs.readFileSync(path.join(d, f), 'utf8');
        const p = yamlNum(t, 'mixed-port') || yamlNum(t, 'port');
        if (allowLan === null) { const m = t.match(/^allow-lan:\s*(true|false)/m); if (m) allowLan = m[1] === 'true'; }
        if (p) cands.push({ port: p, source: `Clash Verge (${f})` });
      } catch {}
    }
  }
  const sys = systemProxyPort();
  if (sys) cands.push(sys);
  cands.push({ port: 7897, source: '默认端口' }, { port: 7890, source: '默认端口' });
  for (const c of cands) {
    if (await isListening(c.port)) return { ...c, listening: true, allowLan };
    if (c.source === '手动设置') return { ...c, listening: false, allowLan };
  }
  return { ...cands[0], listening: false, allowLan };
}

// One reverse tunnel per host, restarted with backoff while it is wanted.
class TunnelManager extends EventEmitter {
  constructor(log) { super(); this.t = new Map(); this.log = log; }

  state(name) {
    const x = this.t.get(name);
    return x ? { state: x.state, remotePort: x.rport, localPort: x.lport, error: x.error || null } : { state: 'off' };
  }

  all() { const o = {}; for (const k of this.t.keys()) o[k] = this.state(k); return o; }

  ensure(h, rport, lport, beforeStart) {
    const x = this.t.get(h.name);
    if (x && x.rport === rport && x.lport === lport && x.state !== 'stopped') return;
    this.stop(h.name);
    const rec = { h, rport, lport, state: 'starting', proc: null, retries: 0, timer: null, beforeStart };
    this.t.set(h.name, rec);
    this._start(rec);
  }

  async _start(rec) {
    if (this.t.get(rec.h.name) !== rec) return;
    rec.state = 'starting'; this.emit('change');
    if (rec.retries > 0 && rec.beforeStart) { try { await rec.beforeStart(); } catch {} }
    if (this.t.get(rec.h.name) !== rec) return;
    let err = '';
    const p = spawnTunnel(rec.h, rec.rport, rec.lport);
    rec.proc = p;
    p.stderr.on('data', (d) => { err += d; });
    const upTimer = setTimeout(() => {
      if (rec.proc === p && p.exitCode === null) {
        rec.state = 'up'; rec.retries = 0; rec.error = null; this.emit('change');
        this.log(`[${rec.h.name}] 隧道已建立 远端 127.0.0.1:${rec.rport} -> 本机 ${rec.lport}`);
      }
    }, 3000);
    p.on('error', (e) => { err += e.message; });
    p.on('exit', (code) => {
      clearTimeout(upTimer);
      if (rec.proc !== p || this.t.get(rec.h.name) !== rec || rec.state === 'stopped') return;
      const msg = err.trim().split('\n').filter((l) => !/^Warning: Permanently/.test(l)).pop() || `ssh exit ${code}`;
      rec.error = msg; rec.state = 'down'; rec.retries += 1; this.emit('change');
      const wait = Math.min(60, 5 * rec.retries);
      this.log(`[${rec.h.name}] 隧道断开: ${msg}，${wait}s 后重试`, 'warn');
      rec.timer = setTimeout(() => this._start(rec), wait * 1000);
    });
  }

  stop(name) {
    const x = this.t.get(name);
    if (!x) return;
    x.state = 'stopped';
    clearTimeout(x.timer);
    if (x.proc && x.proc.exitCode === null) x.proc.kill();
    this.t.delete(name);
    this.emit('change');
  }

  stopAll() { for (const k of [...this.t.keys()]) this.stop(k); }
}

module.exports = { detectLocalProxy, connectTest, isListening, TunnelManager };
