#!/usr/bin/env node
// Automação do registrador dentro do tmux (Linux): envia cada tecla do mapa com `tmux send-keys`.
//   node auto-tmux.mjs                  send-keys direto (o tmux entrega a tecla ao programa)
//   node auto-tmux.mjs --nested         cliente tmux "de verdade": um tmux externo manda as teclas
//                                       a um `tmux attach`, que trata o prefixo Ctrl+B como um terminal real
//   node auto-tmux.mjs --ext always     o tmux parte com `extended-keys always` e `extended-keys-format csi-u`
//   node auto-tmux.mjs --ext pedido     o tmux parte com `extended-keys on`, e o gravador pede o modifyOtherKeys
//                                       (CSI > 4 ; 2 m), como faria uma TUI que quer o Shift+Enter
//   As opções valem para os painéis criados depois delas; por isso vão num arquivo de configuração na partida.
//   `--ext` combina com `--nested`; no aninhado, o tmux interno também recebe `terminal-features xterm*:extkeys`.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITENS } from './map.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));
const nested = process.argv.includes('--nested');
const iExt = process.argv.indexOf('--ext');
const ext = iExt >= 0 ? process.argv[iExt + 1] : null;
if (ext && !['always', 'pedido'].includes(ext)) { console.error('--ext aceita always ou pedido'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'otkeys'; // servidor que roda o gravador (ou o servidor externo, no modo aninhado)
const INN = 'otkeys-in';
const tm = (sock, ...a) => spawnSync('tmux', ['-L', sock, ...a], { encoding: 'utf8', env: { ...process.env, TMUX: '' } });
const cap = (sock) => tm(sock, 'capture-pane', '-p', '-t', 'k').stdout;
const kill = (s) => { try { execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* nada */ } };

const sufixo = (nested ? '-aninhado' : '') + (ext ? `-ext-${ext}` : '');
const arquivo = resolve(aqui, 'resultados', `tmux-linux-auto${sufixo}.json`);
mkdirSync(dirname(arquivo), { recursive: true });
if (existsSync(arquivo)) rmSync(arquivo);
const nome = (nested ? 'tmux no Linux (aninhado, cliente real)' : 'tmux no Linux (send-keys)') + (ext === 'always' ? ', extended-keys always (csi-u)' : ext === 'pedido' ? ', extended-keys on + modifyOtherKeys pedido' : '');
const cmd = `node ${aqui}/keys.mjs --auto ${nested ? 1500 : 2500} --nome '${nome}' --out ${arquivo}${ext === 'pedido' ? ' --pedir-mok' : ''}`;
const tmpCfg = mkdtempSync(resolve(tmpdir(), 'otkeys-'));
const conf = (linhas) => { const f = resolve(tmpCfg, `c${Math.random().toString(36).slice(2)}.conf`); writeFileSync(f, linhas.join('\n') + '\n'); return ['-f', f]; };
const extLinhas = ext === 'always' ? ['set -g extended-keys always', 'set -g extended-keys-format csi-u']
  : ext === 'pedido' ? ['set -g extended-keys on'] : [];
const cfg = ext ? conf(extLinhas) : ['-f', '/dev/null'];
const cfgIn = ext ? conf([...extLinhas, "set -as terminal-features 'xterm*:extkeys'"]) : cfg;

kill(OUT); kill(INN);
try {
  let alvoSock = OUT;
  if (nested) {
    tm(INN, ...cfgIn, 'new-session', '-d', '-s', 'k', '-x', '100', '-y', '30', '-e', 'TERM=xterm-256color', cmd);
    tm(OUT, ...cfg, 'new-session', '-d', '-s', 'k', '-x', '100', '-y', '32', '-e', 'TERM=xterm-256color', `tmux -L ${INN} attach -t k`);
  } else {
    tm(OUT, ...cfg, 'new-session', '-d', '-s', 'k', '-x', '100', '-y', '30', '-e', 'TERM=xterm-256color', cmd);
  }
  const lerTela = () => cap(nested ? INN : OUT);
  const N = ITENS.length;
  for (let i = 0; i < N; i++) {
    const marca = `[${i + 1}/${N}]`;
    const t0 = Date.now();
    while (!lerTela().includes(marca)) { if (Date.now() - t0 > 8000) throw new Error('prompt ' + marca + ' não apareceu'); await sleep(30); }
    await sleep(120);
    const k = ITENS[i].tmux;
    tm(alvoSock, 'send-keys', '-t', 'k', k);
    if (nested && k === 'C-b') {
      await sleep(600);
      if (!lerTela().includes(`[${i + 2}/${N}]`)) tm(alvoSock, 'send-keys', '-t', 'k', 'Escape'); // limpa o prefixo preso no cliente interno
    }
    const t1 = Date.now();
    const prox = i + 1 < N ? `[${i + 2}/${N}]` : 'Gravado em';
    while (!lerTela().includes(prox)) { if (Date.now() - t1 > 6000) break; await sleep(30); }
  }
  const t2 = Date.now();
  while (!existsSync(arquivo) && Date.now() - t2 < 5000) await sleep(50);
  if (!existsSync(arquivo)) throw new Error('JSON não gravado');
  const r = JSON.parse(readFileSync(arquivo, 'utf8'));
  console.log(`${nome}: ${JSON.stringify(r.resumo)}`);
  for (const x of r.itens) console.log(`${x.status.padEnd(26)} ${x.rotulo.padEnd(46)} ${x.recebido ?? ''}  ${x.bytes ?? ''}`);
  console.log('gravado em', arquivo);
} finally {
  kill(OUT); kill(INN);
  rmSync(tmpCfg, { recursive: true, force: true });
}
