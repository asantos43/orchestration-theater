#!/usr/bin/env node
// Registrador de teclas do OTheater (spike da Fase 0, seção 5.13 da arquitetura).
// Node puro, sem dependências. Modo bruto: mostra os bytes de cada tecla e o nome decodificado.
//
//   node keys.mjs                       percorre o mapa de teclas, um item por vez
//   node keys.mjs --livre               só ecoa o que chegar (Ctrl+C duas vezes sai)
//   node keys.mjs --nome "Windows Terminal 1.22"   rótulo do terminal no JSON
//   node keys.mjs --out resultados/x.json
//   node keys.mjs --auto 2500           (uso da automação) desiste do item após N ms sem tecla
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { ITENS } from './map.mjs';
import { decode, hex, repr } from './decode.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const livre = argv.includes('--livre');
const autoMs = Number(arg('--auto', 0)) || 0;
const nome = String(arg('--nome', '') || '');
const GAP = 60; // ms sem bytes novos = fim da sequência

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Rode em um terminal interativo (stdin e stdout precisam ser TTY).');
  process.exit(2);
}

const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();

let pendingChunk = '';
let gapTimer = null;
const queue = [];
let wake = null;

process.stdin.on('data', (d) => {
  pendingChunk += d;
  clearTimeout(gapTimer);
  gapTimer = setTimeout(() => {
    queue.push(pendingChunk);
    pendingChunk = '';
    if (wake) { const w = wake; wake = null; w(); }
  }, GAP);
});

/** espera a próxima tecla (grupo de bytes); null no timeout */
function next(timeoutMs = 0) {
  return new Promise((res) => {
    const tryTake = () => (queue.length ? res(queue.shift()) : false);
    if (tryTake()) return;
    let to = null;
    wake = () => { clearTimeout(to); tryTake(); };
    if (timeoutMs) to = setTimeout(() => { wake = null; res(null); }, timeoutMs);
  });
}

/** separa um grupo de bytes em teclas (colados juntos quando o usuário é rápido) */
function split(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b' && i + 1 < s.length) {
      let m = /^\x1b\[[0-9;:<?]*[@-~]/.exec(s.slice(i)) || /^\x1bO[A-Za-z0-9]/.exec(s.slice(i)) || /^\x1b\x1b\[[0-9;:]*[@-~]/.exec(s.slice(i));
      if (m) { keys.push(m[0]); i += m[0].length; continue; }
      const cp = String.fromCodePoint(s.codePointAt(i + 1));
      keys.push('\x1b' + cp); i += 1 + cp.length; continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i));
    keys.push(cp); i += cp.length;
  }
  return keys;
}

// ---------- sondagem do terminal ----------
async function sonda(consulta, fim, ms = 400) {
  out(consulta);
  const t0 = Date.now();
  let acc = '';
  while (Date.now() - t0 < ms) {
    const g = await next(ms - (Date.now() - t0));
    if (g == null) break;
    acc += g;
    if (fim.test(acc)) break;
  }
  return acc || null;
}

async function sondar() {
  const r = {};
  const kitty = await sonda('\x1b[?u\x1b[c', /\x1b\[\?[\d;]*c/);
  r.kitty = kitty ? /\x1b\[\?(\d+)u/.exec(kitty)?.[0] ?? null : null;
  r.da1 = kitty ? (/\x1b\[\?[\d;]*c/.exec(kitty)?.[0] ?? null) : null;
  const xt = await sonda('\x1b[>0q', /\x1bP>\|[^\x1b]*\x1b\\/, 400);
  r.xtversion = xt ? (/\x1bP>\|([^\x1b]*)\x1b\\/.exec(xt)?.[1] ?? null) : null;
  queue.length = 0;
  return r;
}

const env = {
  TERM: process.env.TERM ?? null,
  COLORTERM: process.env.COLORTERM ?? null,
  TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
  TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION ?? null,
  WT_SESSION: process.env.WT_SESSION ? 'definido' : null,
  VTE_VERSION: process.env.VTE_VERSION ?? null,
  KONSOLE_VERSION: process.env.KONSOLE_VERSION ?? null,
  TMUX: process.env.TMUX ? 'dentro do tmux' : null,
  SSH_TTY: process.env.SSH_TTY ? 'sessão SSH' : null,
  LANG: process.env.LANG ?? null,
};

function sair(code = 0) {
  try { process.stdin.setRawMode(false); } catch { /* ok */ }
  out('\x1b[?25h\x1b[0m\n');
  process.exit(code);
}

// ---------- modo livre ----------
async function modoLivre() {
  out('Modo livre: aperte teclas e veja os bytes. Ctrl+C duas vezes seguidas sai.\r\n\r\n');
  let cc = 0;
  for (;;) {
    const g = await next();
    for (const k of split(g)) {
      const nm = decode(k);
      out(`${nm.padEnd(34)} bytes: ${hex(k).padEnd(24)} ${repr(k)}\r\n`);
      cc = k === '\x03' ? cc + 1 : 0;
      if (cc >= 2) sair(0);
    }
  }
}

// ---------- percurso do mapa ----------
async function percurso() {
  const total = ITENS.length;
  const itens = [];
  out('\x1b[2J\x1b[H');
  out('Registrador de teclas do OTheater\r\n');
  out('Para cada item, aperte a tecla pedida. Ctrl+C pula o item; Ctrl+C duas vezes seguidas aborta.\r\n');
  out('Dica: se a tecla fizer algo no terminal (abrir aba, menu), anote no README e use Ctrl+C para pular.\r\n\r\n');
  let cancelados = 0;
  for (let i = 0; i < total; i++) {
    const it = ITENS[i];
    out(`[${i + 1}/${total}] aperte: ${it.rotulo}\r\n`);
    const g = await next(autoMs);
    if (g == null) {
      itens.push({ id: it.id, rotulo: it.rotulo, status: 'não chegou', recebido: null });
      out('   (nada chegou)\r\n');
      continue;
    }
    const teclas = split(g);
    if (teclas.length === 1 && teclas[0] === '\x03' && it.id !== 'ctrl_c') {
      cancelados++;
      itens.push({ id: it.id, rotulo: it.rotulo, status: 'pulado', recebido: null });
      out('   (pulado)\r\n');
      if (cancelados >= 2) { out('Abortado.\r\n'); break; }
      continue;
    }
    cancelados = 0;
    const k = teclas[0];
    const nm = decode(k);
    let status;
    if (it.esperado.includes(nm.replace(/ \[.*\]$/, ''))) status = 'ok';
    else if (it.id === 'ctrl_j' && nm === 'Enter') status = 'indistinguível do Enter';
    else status = 'diferente';
    itens.push({
      id: it.id, rotulo: it.rotulo, status, recebido: nm, bytes: hex(k), bytesTexto: repr(k),
      ...(teclas.length > 1 ? { extras: teclas.slice(1).map((x) => ({ nome: decode(x), bytes: hex(x) })) } : {}),
    });
    out(`   recebido: ${nm}   bytes: ${hex(k)}   ${repr(k)}   -> ${status}\r\n`);
  }
  return itens;
}

// ---------- principal ----------
const sondas = await sondar();
if (livre) {
  out(`terminal: ${JSON.stringify({ ...env, ...sondas })}\r\n`);
  await modoLivre();
}

const itens = await percurso();
const resumo = itens.reduce((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
const resultado = {
  ferramenta: 'otheater-spike-tui-keys',
  data: new Date().toISOString(),
  nome: nome || null,
  maquina: { plataforma: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
  terminal: { ...env, ...sondas, colunas: process.stdout.columns, linhas: process.stdout.rows },
  resumo,
  itens,
};
const saida = resolve(String(arg('--out', '') || `resultados/${(nome || 'terminal').replace(/[^\w.-]+/g, '_')}.json`));
mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, JSON.stringify(resultado, null, 2) + '\n');
out(`\r\nResumo: ${JSON.stringify(resumo)}\r\nGravado em ${saida}\r\n`);
sair(0);
