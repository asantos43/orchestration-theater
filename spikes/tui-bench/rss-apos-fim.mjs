#!/usr/bin/env node
// Diagnóstico de memória: roda um protótipo em stream por --stream s, depois deixa ocioso até --total s,
// amostrando o RSS do processo a cada 5 s (tmux 160x45, socket próprio). Responde: o RSS continua crescendo depois que o stream para?
//   node rss-apos-fim.mjs --name opentui-rss --cwd ../tui-opentui --cmd "env NODE_ENV=production /caminho/otheater-tui" [--rate 50] [--stream 90] [--total 270]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tmux, Session, sampler, sleep, median } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const name = opt('name', 'rss'), cwd = resolve(opt('cwd', '.')), cmd = opt('cmd');
const rate = Number(opt('rate', 50)), stream = Number(opt('stream', 90)), total = Number(opt('total', 270));
if (!cmd) { console.error('falta --cmd'); process.exit(2); }
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'out', name);
mkdirSync(OUT, { recursive: true });
const conf = resolve(OUT, 'tmux.conf');
writeFileSync(conf, 'set -g default-terminal xterm-256color\nset -g status off\nset -g history-limit 1000\nset -g escape-time 0\n');
const tmux = new Tmux('otbench-' + name, conf);
await tmux.start();
const s = new Session(tmux, { cols: 160, rows: 45, cmd: `${cmd} --scenario stream --rate ${rate} --duration ${stream}`, cwd });
await s.start();
await s.waitFor((t) => t.includes('╭'), 30000, s.t0);
const smp = sampler(s.pid);
await sleep(total * 1000);
const serie = smp.stop();
await s.quit();
await tmux.stop();
const w = (a, b) => median(serie.filter((x) => x.t >= a && x.t < b).map((x) => x.rssMB));
const pontos = Object.fromEntries([0, 30, 60, stream, stream + 30, stream + 90, total - 5].map((t) => [t + 's', serie.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m)).rssMB]));
const res = { rate, stream_s: stream, total_s: total, pontos_MB: pontos, medianaAteFim_MB: w(0, stream), medianaUltimos60s_MB: w(total - 60, total), cpuUltimos60s_pct: median(serie.filter((x) => x.t >= total - 60).map((x) => x.cpu)), serie };
writeFileSync(resolve(OUT, 'rss.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify({ ...res, serie: undefined }, null, 2));
