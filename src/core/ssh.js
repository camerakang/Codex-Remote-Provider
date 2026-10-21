'use strict';
// System OpenSSH wrapper. Scripts go over stdin (`sh -s`), so nothing secret or
// quote-sensitive ever appears on a command line (Windows PowerShell 5.1 mangles
// quotes, and Kaspersky flags credentials in ssh arguments).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function sshBin() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(p)) return p;
  } else if (fs.existsSync('/usr/bin/ssh')) return '/usr/bin/ssh';
  return 'ssh';
}

function hostOpts(h) {
  const a = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
  if (h.port) a.push('-p', String(h.port));
  if (h.identity && fs.existsSync(h.identity)) a.push('-i', h.identity);
  return a;
}

function runScript(h, script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn(sshBin(), ['-T', ...hostOpts(h), h.target, 'sh -s'], { windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, out: out.replace(/\r/g, ''), err: err.replace(/\r/g, '') });
    };
    const timer = setTimeout(() => { p.kill(); finish(124); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += e.message; finish(127); });
    p.on('close', (code) => finish(code));
    p.stdin.on('error', () => {});
    p.stdin.end(script.replace(/\r/g, ''));
  });
}

// Reverse tunnel: remote 127.0.0.1:rport -> local 127.0.0.1:lport.
function spawnTunnel(h, rport, lport) {
  const a = ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', ...hostOpts(h), '-R', `127.0.0.1:${rport}:127.0.0.1:${lport}`, h.target];
  return spawn(sshBin(), a, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = { runScript, spawnTunnel, sshBin };
