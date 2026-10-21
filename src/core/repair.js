'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runScript } = require('./ssh');
const { status } = require('./remote');
const cfg = require('./config');

const python = fs.readFileSync(path.join(__dirname, 'repair.py'), 'utf8').replace(/\r/g, '');
const MODEL_RE = /^[\w .:/-]{1,128}$/;
const LOCAL = '__local__';

function runLocalPython(args, timeout) {
  const candidates = process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
  const env = { ...process.env, CRP_LOCAL: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const attempt = (i) => new Promise((resolve, reject) => {
    if (i >= candidates.length) { reject(new Error('本机需要 Python 3 才能修复本机对话')); return; }
    const [cmd, pre] = candidates[i];
    const child = spawn(cmd, [...pre, '-', ...args], { env, windowsHide: true });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(attempt(i + 1)); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(python);
  });
  return attempt(0);
}

async function run(h, mode, options, timeout) {
  const encoded = Buffer.from(JSON.stringify(options || {}), 'utf8').toString('base64');
  let r;
  if (h.local) {
    r = await runLocalPython([mode, encoded], timeout);
  } else {
    const script = `python3 - ${mode} '${encoded}' <<'__CRP_REPAIR_PY__'
${python}
__CRP_REPAIR_PY__
`;
    r = await runScript(h, script, timeout);
  }
  const marker = r.out.replace(/\r/g, '').split('\n').find((line) => line.startsWith('@CRP_REPAIR_JSON='));
  if (r.code !== 0 || !marker) {
    const detail = (r.err || r.out).trim().split('\n').slice(-2).join(' ').replace(/^REPAIR_ERROR=/, '');
    throw new Error(detail || `会话${mode === 'scan' ? '扫描' : '修复'}失败 (${h.local ? 'python' : 'ssh'} ${r.code})`);
  }
  return JSON.parse(marker.slice('@CRP_REPAIR_JSON='.length));
}

// The local config may be a Codex++ aggregate provider (loopback); it is still valid on this machine.
function localTarget() {
  let text = '';
  try { text = fs.readFileSync(cfg.paths.config, 'utf8'); } catch {}
  const top = cfg.splitToml(text).top;
  return { provider: cfg.topValue(top, 'model_provider') || 'openai', model: cfg.topValue(top, 'model') };
}

async function target(h) {
  if (h.local) return localTarget();
  const st = await status(h);
  return { provider: providerOf(st), model: st.model || null };
}

function providerOf(st) {
  if (!st.online) throw new Error(`主机离线: ${st.error || 'SSH 失败'}`);
  if (st.kind === 'official') return 'openai';
  if (st.kind === 'relay' && st.provider) return st.provider;
  throw new Error('远端当前供应商配置不完整，先修复配置再处理旧对话');
}

async function scan(h) {
  const t = await target(h);
  const data = await run(h, 'scan', {}, 60000);
  return { ...data, targetProvider: t.provider, targetModel: t.model || null };
}

async function apply(h, scanResult, source, model, resetModel = true) {
  if (!scanResult || typeof source !== 'string') throw new Error('请先扫描并选择原供应商');
  const t = await target(h);
  const targetProvider = t.provider;
  if (scanResult.targetProvider !== targetProvider || scanResult.targetModel !== (t.model || null)) {
    throw new Error('当前供应商或模型已变化，请重新扫描');
  }
  if (source === targetProvider) throw new Error('原供应商与当前供应商相同');
  if (resetModel && model && !MODEL_RE.test(model)) throw new Error('模型名称格式不正确');
  const expected = {
    database: scanResult.database[source] || 0,
    files: scanResult.files[source] || 0,
  };
  if (scanResult.invalidFiles.length) throw new Error('存在无法解析的会话文件，已停止修复');
  return run(h, 'repair', {
    source, target: targetProvider, model: resetModel ? (model || null) : null,
    resetModel, expected,
  }, 180000);
}

// Rewrite the model pinned in old rollouts (turn_context / thread settings) and the thread index.
async function applyModel(h, scanResult, sourceModels, targetModel) {
  if (!scanResult || !scanResult.models) throw new Error('请先扫描');
  if (!Array.isArray(sourceModels) || !sourceModels.length) throw new Error('请勾选要替换的旧模型');
  if (![...sourceModels, targetModel].every((m) => MODEL_RE.test(m || ''))) throw new Error('模型名称格式不正确');
  if (sourceModels.includes(targetModel)) throw new Error('旧模型与目标模型相同');
  if (scanResult.invalidFiles.length) throw new Error('存在无法解析的会话文件，已停止修复');
  const expected = {};
  for (const m of sourceModels) {
    expected[m] = { database: (scanResult.dbModels || {})[m] || 0, files: scanResult.models[m] || 0 };
  }
  return run(h, 'repair-model', { sourceModels, targetModel, expected }, 300000);
}

module.exports = { scan, apply, applyModel, providerOf, LOCAL };
