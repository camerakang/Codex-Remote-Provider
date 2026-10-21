'use strict';
const fs = require('fs');
const path = require('path');
const { runScript } = require('./ssh');
const { status } = require('./remote');

const python = fs.readFileSync(path.join(__dirname, 'repair.py'), 'utf8').replace(/\r/g, '');

async function run(h, mode, options, timeout) {
  const encoded = Buffer.from(JSON.stringify(options || {}), 'utf8').toString('base64');
  const script = `python3 - ${mode} '${encoded}' <<'__CRP_REPAIR_PY__'
${python}
__CRP_REPAIR_PY__
`;
  const r = await runScript(h, script, timeout);
  const marker = r.out.split('\n').find((line) => line.startsWith('@CRP_REPAIR_JSON='));
  if (r.code !== 0 || !marker) {
    const detail = (r.err || r.out).trim().split('\n').slice(-2).join(' ');
    throw new Error(detail || `远端会话${mode === 'scan' ? '扫描' : '修复'}失败 (ssh ${r.code})`);
  }
  return JSON.parse(marker.slice('@CRP_REPAIR_JSON='.length));
}

function providerOf(st) {
  if (!st.online) throw new Error(`主机离线: ${st.error || 'SSH 失败'}`);
  if (st.kind === 'official') return 'openai';
  if (st.kind === 'relay' && st.provider) return st.provider;
  throw new Error('远端当前供应商配置不完整，先修复配置再处理旧对话');
}

async function scan(h) {
  const st = await status(h);
  const targetProvider = providerOf(st);
  const data = await run(h, 'scan', {}, 60000);
  return { ...data, targetProvider, targetModel: st.model || null };
}

async function apply(h, scanResult, source, model, resetModel = true) {
  if (!scanResult || typeof source !== 'string') throw new Error('请先扫描并选择原供应商');
  const st = await status(h);
  const targetProvider = providerOf(st);
  if (scanResult.targetProvider !== targetProvider || scanResult.targetModel !== (st.model || null)) {
    throw new Error('远端当前供应商或模型已变化，请重新扫描');
  }
  if (source === targetProvider) throw new Error('原供应商与当前供应商相同');
  if (resetModel && model && !/^[\w./-]{1,128}$/.test(model)) throw new Error('模型名称格式不正确');
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

module.exports = { scan, apply, providerOf };
