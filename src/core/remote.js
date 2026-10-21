'use strict';
// Operations on one remote Codex host: status, provider switch, real test, and the
// managed proxy block in the remote shell rc file.
const fs = require('fs');
const path = require('path');
const { runScript } = require('./ssh');
const cfg = require('./config');

const BLOCK_BEGIN = '# >>> codex-remote-provider proxy >>>';
const BLOCK_END = '# <<< codex-remote-provider proxy <<<';
const RC = 'rc="$HOME/.bashrc"; case "$SHELL" in */zsh) rc="$HOME/.zshrc" ;; esac';
// The desktop app reconnects and starts a fresh app-server, which re-reads config
// and the shell environment. Our own `sh -s` never matches this pattern.
const RESTART = "pkill -f 'app-server --listen' >/dev/null 2>&1 || true";

function heredoc(dest, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64').replace(/.{76}/g, '$&\n');
  return `base64 -d > "${dest}" <<'__CRP_B64__'\n${b64}\n__CRP_B64__\n`;
}

const STATUS = `
echo "@HOME=$HOME"
echo "@CLIENT=\${SSH_CONNECTION%% *}"
if grep -q refresh_token "$HOME/.codex/auth.json" 2>/dev/null; then echo "@LOGIN=chatgpt"
elif [ -s "$HOME/.codex/auth.json" ]; then echo "@LOGIN=apikey"; else echo "@LOGIN=none"; fi
pid=$(pgrep -f 'app-server --listen' 2>/dev/null | head -n 1)
echo "@APP=$pid"
if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
  echo "@APPPROXY=$(tr '\\000' '\\n' < /proc/$pid/environ | sed -n 's/^https_proxy=//p' | head -n 1)"
fi
${RC}
echo "@BLOCK=$(sed -n 's/^# codex-remote-provider url=//p' "$rc" 2>/dev/null | head -n 1)"
echo "@CONFIG<<"
cat "$HOME/.codex/config.toml" 2>/dev/null
echo ""
echo "@CONFIG>>"
`;

function parseStatus(out) {
  const kv = {};
  const lines = out.split('\n');
  let cfgLines = null;
  for (const l of lines) {
    if (cfgLines) { if (l === '@CONFIG>>') break; cfgLines.push(l); continue; }
    if (l === '@CONFIG<<') { cfgLines = []; continue; }
    const m = l.match(/^@(\w+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  return { kv, configText: (cfgLines || []).join('\n') };
}

async function status(h) {
  const r = await runScript(h, STATUS, 20000);
  if (r.code !== 0 || !/@HOME=/.test(r.out)) {
    return { online: false, error: lastLine(r.err) || `ssh exit ${r.code}`, checkedAt: Date.now() };
  }
  const { kv, configText } = parseStatus(r.out);
  const p = configText.trim() ? cfg.parseProfile(configText, 'remote') : { kind: 'official' };
  return {
    online: true, checkedAt: Date.now(),
    home: kv.HOME, client: kv.CLIENT || null, login: kv.LOGIN,
    appServer: kv.APP || null, appProxy: kv.APPPROXY || null, proxyBlock: kv.BLOCK || null,
    kind: p ? p.kind : 'unknown', model: p ? p.model : null, baseUrl: p ? p.baseUrl : null,
    configText,
  };
}

function lastLine(s) {
  const l = String(s || '').trim().split('\n').filter((x) => x.trim() && !/^Warning: Permanently/.test(x));
  return l.length ? l[l.length - 1].trim() : '';
}

// New remote config.toml: provider keys from the target, everything else kept.
function buildConfig(remoteText, target, home) {
  const r = cfg.splitToml(remoteText);
  const top = [];
  if (target.kind === 'relay') top.push(`model_provider = "${target.provider}"`);
  if (target.model) top.push(`model = "${target.model}"`);
  if (target.effort) top.push(`model_reasoning_effort = "${target.effort}"`);
  if (target.kind === 'relay' && target.catalog) {
    top.push(`model_catalog_json = '${home}/.codex/model-catalogs/${path.basename(target.catalog)}'`);
  }
  const body = [...top, ...r.rest];
  if (target.kind === 'relay') body.push('', ...target.table);
  return { text: body.join('\n').trimEnd() + '\n', head: [...top, ...(target.kind === 'relay' ? target.table : [])] };
}

const mask = (l) => l.replace(/(token\s*=\s*["'][^"']{4})[^"']*/, '$1****');

// target: { kind: 'official' } or a relay profile from config.listRelays().
async function switchProvider(h, target, { dryRun = false, pushAuth = false, st = null } = {}) {
  st = st || await status(h);
  if (!st.online) throw new Error(`离线或 SSH 失败: ${st.error}`);
  if (target.kind === 'official' && st.login !== 'chatgpt' && !pushAuth) {
    throw new Error('远端没有官方登录 (auth.json 无 refresh_token)，请先在远端执行 codex login');
  }
  const { text, head } = buildConfig(st.configText, target, st.home);
  if (dryRun) return { dryRun: true, preview: head.map(mask) };
  let s = 'set -e\nmkdir -p "$HOME/.codex/model-catalogs"\ncd "$HOME/.codex"\nstamp=$(date +%Y%m%d-%H%M%S)\n';
  if (target.kind === 'relay' && target.catalog) {
    s += heredoc(`model-catalogs/${path.basename(target.catalog)}`, cfg.normalizedCatalog(target.catalog));
  }
  s += heredoc('config.toml.new', text);
  s += '[ -f config.toml ] && cp -p config.toml "config.toml.bak-$stamp"\nchmod 600 config.toml.new\nmv config.toml.new config.toml\n';
  if (pushAuth && target.kind === 'official') {
    s += heredoc('auth.json.new', fs.readFileSync(cfg.paths.auth, 'utf8'));
    s += '[ -f auth.json ] && cp -p auth.json "auth.json.bak-$stamp"\nchmod 600 auth.json.new\nmv auth.json.new auth.json\n';
  }
  s += `${RESTART}\necho "@STAMP=$stamp"\n`;
  const r = await runScript(h, s, 60000);
  const m = r.out.match(/@STAMP=(\S+)/);
  if (r.code !== 0 || !m) throw new Error(`写入失败: ${lastLine(r.err) || r.code}`);
  return { stamp: m[1], preview: head.map(mask) };
}

async function testCodex(h, model) {
  const m = model && /^[\w.\-/]+$/.test(model) ? `-m ${model} ` : '';
  // bash -i loads ~/.bashrc (PATH, proxy) the way the desktop's login shell does.
  const s = `cd "$HOME"\ntimeout 150 bash -ic 'codex exec --skip-git-repo-check ${m}"Reply with exactly: PROVIDER_OK" </dev/null 2>&1' </dev/null 2>/dev/null | tail -n 25\n`;
  const r = await runScript(h, s, 180000);
  const lines = r.out.split('\n').filter((l) => l.trim());
  const ok = lines.some((l) => l.trim() === 'PROVIDER_OK');
  return { ok, tail: lines.slice(-12) };
}

// url = null removes the managed block. Restarts the app-server so it picks up the change.
async function setProxy(h, url) {
  let s = `set -e\n${RC}\ntouch "$rc"\n[ -f "$rc.bak-codex-proxy" ] || cp -p "$rc" "$rc.bak-codex-proxy"\n`;
  s += `tmp="$rc.crp.$$"\nawk '$0=="${BLOCK_BEGIN}"{s=1} !s{print} $0=="${BLOCK_END}"{s=0}' "$rc" > "$tmp"\n`;
  if (url) {
    const np = 'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local';
    const block = [
      BLOCK_BEGIN,
      `# codex-remote-provider url=${url}`,
      `export http_proxy="${url}" https_proxy="${url}" HTTP_PROXY="${url}" HTTPS_PROXY="${url}"`,
      `export no_proxy="${np}" NO_PROXY="${np}"`,
      BLOCK_END,
    ].join('\n') + '\n';
    s += `cat >> "$tmp" <<'__CRP_BLOCK__'\n${block}__CRP_BLOCK__\n`;
  }
  s += `cat "$tmp" > "$rc"\nrm -f "$tmp"\n${RESTART}\necho "@OK"\n`;
  const r = await runScript(h, s, 30000);
  if (r.code !== 0 || !/@OK/.test(r.out)) throw new Error(`写入代理配置失败: ${lastLine(r.err) || r.code}`);
}

// Reachability of chatgpt.com through a proxy URL, measured on the remote.
async function testProxy(h, url) {
  // No leading "@" in -w: curl would read the format from a file of that name.
  const s = `if command -v curl >/dev/null 2>&1; then curl -sS -m 10 -x '${url}' -o /dev/null -w 'HTTP=%{http_code} TIME=%{time_total}\\n' https://chatgpt.com/ </dev/null 2>&1 | tail -n 2; else echo "HTTP=nocurl"; fi\n`;
  const r = await runScript(h, s, 25000);
  const code = (r.out.match(/HTTP=(\w+)/) || [])[1] || 'error';
  const time = parseFloat((r.out.match(/TIME=([\d.]+)/) || [])[1] || 'NaN');
  return { ok: /^\d+$/.test(code) && code !== '000', code, ms: isNaN(time) ? null : Math.round(time * 1000), detail: lastLine(r.out) };
}

// Kill a leftover sshd from an earlier tunnel that still holds the remote port.
async function freeRemotePort(h, port) {
  const s = `pids=$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
for p in $pids; do [ "$(ps -o comm= -p "$p" 2>/dev/null)" = sshd ] && kill "$p" 2>/dev/null; done; true\n`;
  await runScript(h, s, 15000);
}

module.exports = { status, switchProvider, testCodex, setProxy, testProxy, freeRemotePort, buildConfig };
