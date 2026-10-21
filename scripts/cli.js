#!/usr/bin/env node
'use strict';
// Headless use of the same core: node scripts/cli.js <command> [host...]
//   status | relays | proxy | official|relay|current [--test] [--dry-run] | test | proxy-set <mode> | proxy-test
const { Service } = require('../src/core/service');
const cfg = require('../src/core/config');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos.shift();
const svc = new Service();
svc.on('log', (e) => console.log(`${e.level === 'error' ? '!' : e.level === 'ok' ? '+' : ' '} ${e.msg}`));

(async () => {
  let names = pos;
  if (['official', 'relay', 'current', 'test', 'status', 'proxy-test'].includes(cmd) && !names.length) names = svc.activeHosts().map((h) => h.name);
  switch (cmd) {
    case 'status':
      for (const n of names) {
        const s = await svc.refreshHost(n);
        const { configText, ...rest } = s;
        console.log(n, JSON.stringify(rest));
      }
      break;
    case 'relays': console.log(cfg.listRelays().map(cfg.publicProfile)); console.log('local:', cfg.publicProfile(cfg.localProfile())); break;
    case 'proxy': console.log(await svc.detectProxy()); break;
    case 'official': case 'relay': case 'current':
      await svc.switchHosts(names, cmd, null, { test: flags.has('--test'), dryRun: flags.has('--dry-run') }); break;
    case 'test': for (const n of names) await svc.test(n); break;
    case 'proxy-set': {
      const mode = names.shift();
      for (const n of names) await svc.setProxyMode(n, mode).catch(() => {});
      if (mode === 'tunnel') { console.log('tunnel held for 20s'); await new Promise((r) => setTimeout(r, 20000)); }
      break;
    }
    case 'proxy-test': for (const n of names) await svc.proxyTest(n); break;
    default: console.log('usage: cli.js status|relays|proxy|official|relay|current|test|proxy-set <off|lan|tunnel>|proxy-test [host...]');
  }
  svc.shutdown();
})().catch((e) => { console.error(e); svc.shutdown(); process.exit(1); });
