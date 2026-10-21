'use strict';
// Local Codex / Codex++ configuration: paths, TOML splitting, provider profiles,
// SSH host discovery and app settings. Pure Node, shared by Windows and macOS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// Not app.getPath('userData'): on Windows the Codex desktop app is MSIX-packaged and
// redirects AppData writes made from its terminals. ~/.codex is never redirected.
const stateDir = path.join(codexHome, 'provider-sync');
const paths = {
  codexHome,
  config: path.join(codexHome, 'config.toml'),
  auth: path.join(codexHome, 'auth.json'),
  globalState: path.join(codexHome, '.codex-global-state.json'),
  backups: path.join(codexHome, 'backups'),
  stateDir,
  settings: path.join(stateDir, 'app-settings.json'),
  log: path.join(stateDir, 'app.log'),
};
fs.mkdirSync(stateDir, { recursive: true });

const TOP_KEYS = /^(model_provider|model|model_reasoning_effort|model_catalog_json)\s*=/;
const PROVIDER_HEADER = /^\s*\[model_providers(\.|\])/;

// Split a config into the provider-related top-level keys, the [model_providers.*]
// tables, and everything else (kept untouched on the remote).
function splitToml(text) {
  const top = [], prov = [], rest = [];
  let inTable = false, inProv = false;
  for (const l of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*\[/.test(l)) { inTable = true; inProv = PROVIDER_HEADER.test(l); }
    if (!inTable && TOP_KEYS.test(l)) top.push(l);
    else if (inProv) prov.push(l);
    else rest.push(l);
  }
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  return { top, prov, rest };
}

function topValue(lines, key) {
  const re = new RegExp('^' + key + '\\s*=\\s*["\']([^"\']*)');
  for (const l of lines) { const m = l.match(re); if (m) return m[1]; }
  return null;
}

const isLoopback = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(url || '');

// Classify a config: official (no custom provider), relay (custom provider with a
// real URL) or aggregate (Codex++ local proxy on loopback, unusable remotely).
function parseProfile(text, origin) {
  const c = splitToml(text);
  const provider = topValue(c.top, 'model_provider');
  const p = {
    origin, provider, kind: null,
    model: topValue(c.top, 'model'),
    effort: topValue(c.top, 'model_reasoning_effort'),
    table: [], baseUrl: null, token: null, catalog: null,
  };
  let cat = topValue(c.top, 'model_catalog_json');
  if (cat) {
    cat = cat.replace(/\\\\/g, '\\');
    if (!path.isAbsolute(cat)) cat = path.join(codexHome, cat);
    if (fs.existsSync(cat)) p.catalog = cat;
  }
  if (!provider || provider === 'openai') { p.kind = 'official'; return p; }
  const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp('^\\s*\\[model_providers\\.["\']?' + esc + '["\']?\\]');
  let sel = false;
  for (const l of c.prov) {
    if (/^\s*\[/.test(l)) sel = head.test(l);
    if (!sel) continue;
    p.table.push(l);
    let m = l.match(/^\s*base_url\s*=\s*["']([^"']+)/); if (m) p.baseUrl = m[1];
    m = l.match(/^\s*experimental_bearer_token\s*=\s*["']([^"']+)/); if (m) p.token = m[1];
  }
  if (!p.baseUrl) return null;
  p.kind = isLoopback(p.baseUrl) ? 'aggregate' : 'relay';
  return p;
}

function readProfile(file) {
  try { return parseProfile(fs.readFileSync(file, 'utf8'), file); } catch { return null; }
}

function localProfile() { return readProfile(paths.config); }

// Codex++ relays without experimental_bearer_token keep the key as OPENAI_API_KEY
// in the auth.json saved next to that config. Inline it into the provider table so
// the remote host's own auth.json (its ChatGPT login) never has to change.
function inlineKey(p, file) {
  if (p.token || p.table.some((l) => /^\s*env_key\s*=/.test(l))) return;
  const dir = path.dirname(file);
  if (file !== paths.config && path.dirname(dir) !== paths.backups) return;
  try {
    const key = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).OPENAI_API_KEY;
    if (!key || typeof key !== 'string') return;
    while (p.table.length && !p.table[p.table.length - 1].trim()) p.table.pop();
    p.table.push(`experimental_bearer_token = ${JSON.stringify(key)}`);
    p.token = key;
  } catch {}
}

// Every distinct relay (base_url + token) seen in the live config, Codex++ live
// backups and config.toml.bak* files; the live config first, then newest first.
function listRelays() {
  const files = [paths.config];
  try { for (const d of fs.readdirSync(paths.backups)) files.push(path.join(paths.backups, d, 'config.toml')); } catch {}
  try { for (const f of fs.readdirSync(codexHome)) if (f.startsWith('config.toml.bak')) files.push(path.join(codexHome, f)); } catch {}
  const stamped = files.filter((f) => fs.existsSync(f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => (a.f === paths.config ? -1 : b.f === paths.config ? 1 : b.t - a.t));
  const seen = new Map();
  for (const { f, t } of stamped) {
    const p = readProfile(f);
    if (!p || p.kind !== 'relay') continue;
    inlineKey(p, f);
    if (!p.token && !p.table.some((l) => /^\s*env_key\s*=/.test(l))) continue;
    const id = crypto.createHash('sha256').update(p.baseUrl + '\0' + (p.token || '')).digest('hex').slice(0, 12);
    const prev = seen.get(id);
    // Keep the newest snapshot, but prefer one that carries a model catalog.
    if (prev && (prev.catalog || !p.catalog)) continue;
    p.id = id; p.mtime = t;
    seen.set(id, p);
  }
  return [...seen.values()];
}

function relayById(id) {
  const all = listRelays();
  return all.find((r) => r.id === id) || all[0] || null;
}

// UI view of a profile: tokens never leave the main process.
function publicProfile(p) {
  if (!p) return null;
  return {
    id: p.id || null, kind: p.kind, provider: p.provider, model: p.model, effort: p.effort,
    baseUrl: p.baseUrl, catalog: p.catalog ? path.basename(p.catalog) : null,
    tokenHint: p.token ? p.token.slice(0, 5) + '...' + p.token.slice(-4) : null,
  };
}

function expandHome(p) { return p ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : p; }

const DEFAULT_SETTINGS = {
  excluded: [],
  extraHosts: [],
  testAfterSwitch: false,
  closeToTray: true,
  localProxyPort: null, // null = auto-detect
  proxy: {}, // host name -> { mode: 'off'|'lan'|'tunnel', remotePort }
  lastRelay: null,
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(paths.settings, 'utf8')) }; } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(s) {
  fs.writeFileSync(paths.settings, JSON.stringify(s, null, 2));
  return s;
}

// SSH hosts known to the Codex desktop app, plus manually added ones.
function discoverHosts() {
  const list = [];
  try {
    const text = fs.readFileSync(paths.globalState, 'utf8');
    let conns;
    try { conns = JSON.parse(text)['codex-managed-remote-connections']; } catch {
      const m = text.match(/"codex-managed-remote-connections"\s*:\s*(\[[^\]]*\])/);
      conns = m ? JSON.parse(m[1]) : [];
    }
    for (const c of conns || []) {
      const target = c.alias || c.hostname;
      if (!target) continue;
      const identity = c.identity ? expandHome(c.identity.replace(/\.pub$/, '')) : null;
      list.push({ name: c.displayName || target, target, port: c.sshPort || null, identity });
    }
  } catch {}
  for (const h of loadSettings().extraHosts || []) if (!list.some((x) => x.name === h.name)) list.push(h);
  return list;
}

// Older remote Codex builds reject catalogs missing boolean fields such as
// supports_reasoning_summaries; add them as false.
function normalizedCatalog(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = j.models || [];
  const bools = new Set();
  for (const m of models) for (const [k, v] of Object.entries(m)) if (typeof v === 'boolean') bools.add(k);
  for (const m of models) for (const k of bools) if (!(k in m)) m[k] = false;
  return JSON.stringify(j);
}

module.exports = {
  paths, splitToml, topValue, parseProfile, readProfile, localProfile, listRelays, relayById,
  publicProfile, discoverHosts, loadSettings, saveSettings, normalizedCatalog, isLoopback,
};
