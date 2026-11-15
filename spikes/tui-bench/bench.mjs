#!/usr/bin/env node
// Bancada de medição das TUIs (Fase 0, Ink × OpenTUI). Independente do framework: só precisa do comando do protótipo.
//
//   node bench.mjs run --name ink --cwd ../tui-ink --cmd "node dist/main.js" [--only startup,stream20,stream50,history,layout]
//                      [--duration 300] [--tag texto]
//   node bench.mjs table out/ink/summary.json out/opentui/summary.json   (tabela Markdown comparativa)
//
// O protótipo recebe, por cima de --cmd: --scenario stream --rate N --duration S   ou   --scenario history --messages M --steps P
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Tmux, Session, sampler, procTree, ticksToSec, analyze, countSeqs, stats, median, round, sleep, now, pct } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

if (mode === 'table') { tableMode(argv.slice(1)); process.exit(0); }
if (mode !== 'run') {
  console.error('uso: node bench.mjs run --name N --cwd DIR --cmd "COMANDO" [--only a,b] [--duration 300]\n     node bench.mjs table a.json b.json');
  process.exit(2);
}

const name = opt('name', 'proto');
const cwd = resolve(opt('cwd', '.'));
const cmd = opt('cmd');
if (!cmd) { console.error('falta --cmd'); process.exit(2); }
const only = opt('only', 'startup,stream20,stream50,history,layout').split(',');
const DUR = Number(opt('duration', 300));
const tag = opt('tag', '');
const OUT = resolve(HERE, 'out', name);
mkdirSync(OUT, { recursive: true });
const conf = resolve(OUT, 'tmux.conf');
writeFileSync(conf, 'set -g default-terminal xterm-256color\nset -g status off\nset -g history-limit 1000\nset -g escape-time 0\nset -g remain-on-exit off\n');

const tmux = new Tmux('otbench-' + name, conf);
const log = (...a) => console.error(`[${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}]`, ...a);
const save = (file, obj) => writeFileSync(resolve(OUT, file), JSON.stringify(obj, null, 2));
const withArgs = (a) => `${cmd} ${a}`;

const summary = {
  nome: name,
  tag,
  cmd,
  inicio: new Date().toISOString(),
  maquina: {
    so: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    nucleos: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    tmux: execFileSync('tmux', ['-V']).toString().trim(),
    term: 'xterm-256color (tmux headless 160x45)',
    cargaNoInicio: os.loadavg().map((x) => Math.round(x * 100) / 100),
  },
};

async function newSession(args, o = {}) {
  const s = new Session(tmux, { cols: 160, rows: 45, cmd: withArgs(args), cwd, ...o });
  await s.start();
  return s;
}

// ---------- startup e RSS ocioso ----------
async function scnStartup() {
  const res = { baseline_ms: [], idle_ms: [], history_ms: [], history_estavel_ms: [] };
  // sobrecarga do tmux+shell: tempo até aparecer um caractere num comando trivial
  for (let i = 0; i < 5; i++) {
    const s = new Session(tmux, { cmd: "printf '╭\\n'; sleep 2", cwd });
    await s.start();
    const r = await s.waitFor((t) => t.includes('╭'), 5000, s.t0);
    res.baseline_ms.push(r.ms);
    await s.kill();
  }
  let idle = null;
  for (let i = 0; i < 5; i++) {
    const s = await newSession('--scenario stream --rate 0 --duration 0');
    const r = await s.waitFor((t) => t.includes('╭'), 20000, s.t0);
    res.idle_ms.push(r.ms);
    if (i === 4) {
      // RSS e CPU ociosos: 10 s sem tocar em nada
      const smp = sampler(s.pid);
      const t0c = smp.ticksNow();
      await sleep(10000);
      const series = smp.stop();
      const cpuPct = ((smp.ticksNow() - t0c) / 100 / 10) * 100;
      idle = { rssMB: median(series.map((x) => x.rssMB)), rssMax: Math.max(...series.map((x) => x.rssMB)), cpuPct: round(cpuPct), processo: series.at(-1)?.proc };
      s.final = await s.cap();
      writeFileSync(resolve(OUT, 'startup-idle.screen.txt'), s.final ?? '');
      await s.quit();
    } else await s.kill();
  }
  for (let i = 0; i < 3; i++) {
    const s = await newSession('--scenario history --messages 5000 --steps 1000');
    const r = await s.waitFor((t) => t.includes('╭'), 30000, s.t0);
    res.history_ms.push(r.ms);
    const st = await s.settle(10000);
    res.history_estavel_ms.push(st.ms == null ? null : now() - s.t0);
    await s.kill();
  }
  const out = {
    sobrecargaTmuxShell_ms: stats(res.baseline_ms),
    partidaOciosa_ms: stats(res.idle_ms),
    partidaHistorico5000_primeiroQuadro_ms: stats(res.history_ms),
    partidaHistorico5000_telaEstavel_ms: stats(res.history_estavel_ms),
    ocioso: idle,
    bruto: res,
  };
  save('startup.json', out);
  return out;
}

// ---------- streaming ----------
async function scnStream(rate, duration) {
  const tagn = `stream${rate}`;
  const raw = resolve(OUT, `${tagn}.raw`);
  writeFileSync(raw, '');
  const s = await newSession(`--scenario stream --rate ${rate} --duration ${duration}`, { rawFile: raw, delay: 0.3 });
  const first = await s.waitFor((t) => t.includes('╭'), 30000, s.t0);
  if (first.ms == null) throw new Error('o protótipo não desenhou nada em 30 s');
  const smp = sampler(s.pid);
  const t0 = now();
  const lat = [];
  const samples = []; // verificações periódicas de integridade
  const quebradas = []; // telas das amostras com borda quebrada (para diagnóstico)
  let rawStart = existsSync(raw) ? statSync(raw).size : 0;
  let nextShot = 10000;
  let alive = true;
  const probe = async () => {
    // latência de digitação: "Z" maiúsculo nunca aparece no texto gerado
    const base = await s.cap();
    if (base == null) { alive = false; return; }
    const n0 = (base.match(/Z/g) || []).length;
    const t = now();
    await s.text('Z');
    const r = await s.waitFor((x) => (x.match(/Z/g) || []).length > n0, 3000, t);
    lat.push(r.ms);
    await s.keys('BSpace');
    await s.waitFor((x) => (x.match(/Z/g) || []).length <= n0, 2000);
  };
  while (now() - t0 < duration * 1000 && alive) {
    const t = now();
    await probe();
    if (now() - t0 >= nextShot) {
      const sc = await s.cap();
      if (sc) {
        const a = analyze(sc, 160, 45);
        a.t_s = round((now() - t0) / 1000);
        samples.push(a);
        if (!a.bordasOk) quebradas.push(`===== t=${a.t_s} s =====\n${sc}\n`);
      }
      nextShot += 10000;
    }
    const wait = 2000 - (now() - t);
    if (wait > 0) await sleep(wait);
  }
  const series = smp.stop();
  const elapsed = (now() - t0) / 1000;
  const finalScreen = await s.cap();
  writeFileSync(resolve(OUT, `${tagn}.screen.txt`), finalScreen ?? '');
  const quit = await s.quit();
  await sleep(300);
  const rawBuf = readFileSync(raw);
  const seqs = countSeqs(rawBuf);
  const tail = series.slice(Math.min(5, series.length - 1));
  const rss = series.map((x) => x.rssMB);
  const cpu = series.map((x) => x.cpu);
  const half = Math.floor(rss.length / 2);
  const out = {
    taxa: rate,
    duracaoPedida_s: duration,
    duracaoMedida_s: round(elapsed),
    primeiroQuadro_ms: round(first.ms),
    latenciaDigitacao_ms: stats(lat),
    latenciaMediaBruta_ms: lat.length ? round(lat.filter((x) => x != null).reduce((a, b) => a + b, 0) / lat.filter((x) => x != null).length) : null,
    rssMB: { inicio: rss[0], mediana: median(rss), p95: pct(rss, 95), max: Math.max(...rss), fim: rss.at(-1), medianaPrimeiraMetade: median(rss.slice(0, half)), medianaSegundaMetade: median(rss.slice(half)) },
    cpuPct: { mediana: median(cpu), media: round(cpu.reduce((a, b) => a + b, 0) / cpu.length), p95: pct(cpu, 95), max: Math.max(...cpu) },
    saidaPty: {
      bytes: seqs.bytes,
      bytesPorSegundo: Math.round((seqs.bytes - 0) / elapsed),
      ...seqs,
      limpezasPorSegundo: round((seqs.ED2_ESC_2J + seqs.ED_ESC_J + seqs.EL_ESC_K + seqs.EL2_ESC_2K) / elapsed),
      quadrosSincronizadosPorSegundo: round(seqs.sync2026 / elapsed),
    },
    integridadeDuranteStream: { amostras: samples.length, comBordasQuebradas: samples.filter((x) => !x.bordasOk).length, exemplo: samples.find((x) => !x.bordasOk)?.falhas ?? null, instantes_s: samples.filter((x) => !x.bordasOk).map((x) => x.t_s) },
    saiuComCtrlQ: quit,
    serie: series,
    amostraInicioIgnorada: rawStart,
  };
  void tail;
  save(`${tagn}.json`, out);
  if (quebradas.length) writeFileSync(resolve(OUT, `${tagn}.quebradas.txt`), quebradas.join('\n'));
  return out;
}

// ---------- rolagem ----------
async function pageLatencies(s, key, label) {
  // 200 teclas em blocos de 25 PageUp e 25 PageDown, cada uma medida até a tela mudar
  const lat = [];
  const keys = [];
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 25; i++) keys.push('PageUp');
    for (let i = 0; i < 25; i++) keys.push('PageDown');
  }
  void key;
  for (const k of keys) {
    const base = await s.cap();
    const t = now();
    await s.keys(k);
    const r = await s.waitFor((x) => x !== base, 3000, t);
    lat.push(r.ms);
  }
  return { area: label, ...stats(lat), bruto: lat.map((x) => round(x)) };
}

async function scnHistory() {
  const s = await newSession('--scenario history --messages 5000 --steps 1000');
  const first = await s.waitFor((t) => t.includes('╭'), 60000, s.t0);
  const st = await s.settle(15000);
  const tOpen = { primeiroQuadro_ms: round(first.ms), telaEstavel_ms: st.ms == null ? null : round(now() - s.t0) };
  await sleep(1500);
  const smp = sampler(s.pid);
  await sleep(3500);
  const antes = median(smp.series.map((x) => x.rssMB));
  writeFileSync(resolve(OUT, 'history-inicial.screen.txt'), (await s.cap()) ?? '');
  const chat = await pageLatencies(s, 'PageUp', 'chat');
  await s.keys('Tab');
  await sleep(300);
  const painel = await pageLatencies(s, 'PageUp', 'painel');
  writeFileSync(resolve(OUT, 'history-painel.screen.txt'), (await s.cap()) ?? '');
  await sleep(1500);
  // segunda rodada no chat: a memória tem de ficar estável
  await s.keys('Tab');
  await sleep(300);
  const chat2 = await pageLatencies(s, 'PageUp', 'chat (2ª rodada)');
  // rodadas extras: a memória do V8 cresce até um patamar; o que importa é se o patamar se mantém (sem vazamento)
  const rssRodada = [round(procTree(s.pid).rssMax / 1048576)];
  const extras = [];
  for (let r = 3; r <= 5; r++) {
    extras.push(stripRaw(await pageLatencies(s, 'PageUp', `chat (rodada ${r})`)));
    await sleep(1000);
    rssRodada.push(round(procTree(s.pid).rssMax / 1048576));
  }
  await sleep(2500);
  const series = smp.stop();
  const rss = series.map((x) => x.rssMB);
  const depois = median(rss.slice(-3));
  const out = {
    abertura: tOpen,
    rssMB: { antes, depois, max: Math.max(...rss), deltaDepoisMenosAntes: round(depois - antes), estavel: Math.abs(depois - antes) <= Math.max(10, antes * 0.1), rssFimDaRodada2a5: rssRodada, patamar: Math.abs(rssRodada[3] - rssRodada[1]) <= Math.max(5, rssRodada[1] * 0.03) },
    extras,
    chat: stripRaw(chat),
    painel: stripRaw(painel),
    chat2: stripRaw(chat2),
    cpuPct: { mediana: median(series.map((x) => x.cpu)), max: Math.max(...series.map((x) => x.cpu)) },
    serie: series,
    bruto: { chat: chat.bruto, painel: painel.bruto, chat2: chat2.bruto },
    saiuComCtrlQ: await s.quit(),
  };
  save('history.json', out);
  return out;
}
const stripRaw = ({ bruto, ...r }) => r;

// ---------- layout ----------
async function scnLayout() {
  const s = await newSession('--scenario history --messages 5000 --steps 1000');
  await s.waitFor((t) => t.includes('╭'), 60000, s.t0);
  await s.settle(15000);
  const passos = [];
  const shots = [];
  let ref = await s.cap();
  const step = async (rotulo, acao, esperaMudar = true) => {
    const antes = await s.cap();
    const t = now();
    await acao();
    let r;
    if (esperaMudar) r = await s.waitFor((x) => x !== antes, 3000, t);
    const st = await s.settle(5000);
    const tela = st.screen ?? '';
    const a = analyze(tela, s.cols, s.rows);
    const p = { passo: rotulo, tamanho: `${s.cols}x${s.rows}`, mudou: tela !== antes, latenciaAteMudar_ms: r ? round(r.ms) : null, estabilizouEm_ms: st.ms == null ? null : round(now() - t), ...a };
    passos.push(p);
    shots.push(`===== ${rotulo} (${s.cols}x${s.rows}) =====\n${tela}\n`);
    return tela;
  };
  const p0 = await step('inicial', async () => {}, false);
  const ctrlRight = await step('Ctrl+→ (chat mais largo)', () => s.keys('C-Right'));
  await step('Ctrl+→ de novo', () => s.keys('C-Right'));
  await step('Ctrl+← (volta)', () => s.keys('C-Left'));
  const ctrlLeftBack = await step('Ctrl+← (volta ao início)', () => s.keys('C-Left'));
  await step('Ctrl+← (chat mais estreito que o padrão)', () => s.keys('C-Left'));
  await step('Ctrl+→ (restaura)', () => s.keys('C-Right'));
  await step('Ctrl+B (recolhe a lateral)', () => s.keys('C-b'));
  const altB = await step('Alt+B (expande a lateral)', () => s.keys('M-b'));
  await step('Alt+B (recolhe de novo)', () => s.keys('M-b'));
  const ctrlBBack = await step('Ctrl+B (expande de novo)', () => s.keys('C-b'));
  await step('Ctrl+J (fecha o painel)', () => s.keys('C-j'));
  const altJ = await step('Alt+J (abre o painel)', () => s.keys('M-j'));
  await step('Alt+J (fecha de novo)', () => s.keys('M-j'));
  const ctrlJBack = await step('Ctrl+J (abre de novo)', () => s.keys('C-j'));
  const equal = {
    ctrlRight_ctrlLeft_restauram: ctrlLeftBack === p0 || ctrlLeftBack === (passos[0] && p0),
    altB_igual_ao_inicial: altB === p0,
    ctrlB_igual_ao_inicial: ctrlBBack === p0,
    altJ_igual_ao_inicial: altJ === p0,
    ctrlJ_igual_ao_inicial: ctrlJBack === p0,
  };
  void ctrlRight;
  for (const [c, r] of [[80, 24], [200, 60], [120, 30], [160, 45]]) {
    await step(`resize ${c}x${r}`, async () => { await s.resize(c, r); });
    if (c === 80) {
      await step('80x24 + Ctrl+B (lateral recolhida)', () => s.keys('C-b'));
      await step('80x24 + Ctrl+J (painel)', () => s.keys('C-j'));
      await step('80x24 + Ctrl+B + Ctrl+J (restaura)', async () => { await s.keys('C-b'); await s.keys('C-j'); });
    }
    if (c === 120) {
      await step('120x30 + Ctrl+→', () => s.keys('C-Right'));
      await step('120x30 + Ctrl+←', () => s.keys('C-Left'));
    }
  }
  // redimensionamento rápido em sequência (arrastar a janela): 10 tamanhos em ~1 s
  const tamanhos = [[100, 30], [110, 33], [95, 28], [130, 40], [90, 26], [150, 44], [85, 25], [140, 38], [105, 31], [160, 45]];
  for (const [c, r] of tamanhos) { await s.resize(c, r); await sleep(80); }
  await step('rajada de 10 resizes, termina em 160x45', async () => {}, false);
  const out = {
    teclasRestauram: equal,
    resumo: {
      passos: passos.length,
      bordasOk: passos.filter((p) => p.bordasOk).length,
      acentosEBlocosOk: passos.filter((p) => p.acentos && p.blocos).length,
      todosOk: passos.filter((p) => p.ok).length,
      passosComProblema: passos.filter((p) => !p.ok).map((p) => `${p.passo} @${p.tamanho}: ${p.falhas.join('; ') || (!p.cabeNaTela ? 'excede a tela' : !p.acentos ? 'sem acento' : !p.blocos ? 'sem █/░' : 'cantos')}`),
    },
    passos,
    saiuComCtrlQ: await s.quit(),
  };
  writeFileSync(resolve(OUT, 'layout.screens.txt'), shots.join('\n'));
  save('layout.json', out);
  return out;
}

// ---------- execução ----------
function mdTable(sum) {
  const L = [];
  const r = sum.resultados;
  L.push(`## ${sum.nome}${sum.tag ? ' (' + sum.tag + ')' : ''}`, '', `Comando: \`${sum.cmd}\`  `, `Máquina: ${sum.maquina.so}, ${sum.maquina.cpu} (${sum.maquina.nucleos} núcleos), ${sum.maquina.ramGB} GB, Node ${sum.maquina.node}, ${sum.maquina.tmux}; ${sum.maquina.term}. Carga (loadavg 1/5/15 min) no início: ${sum.maquina.cargaNoInicio?.join('/')}; no fim: ${sum.maquina.cargaNoFim?.join('/')}.`, '', '| Medida | Valor |', '|---|---|');
  const row = (a, b) => L.push(`| ${a} | ${b} |`);
  for (const k of Object.keys(r)) if (r[k]?.erro) L.push(`| ERRO em ${k} | ${r[k].erro.split('\n')[0]} |`);
  if (r.startup && !r.startup.erro) {
    const x = r.startup;
    row('Sobrecarga tmux+shell (p50 / p95 ms)', `${x.sobrecargaTmuxShell_ms.p50} / ${x.sobrecargaTmuxShell_ms.p95}`);
    row('Partida ociosa, até o 1º quadro (p50 / máx ms, n=5)', `${x.partidaOciosa_ms.p50} / ${x.partidaOciosa_ms.max}`);
    row('Partida com 5.000 msgs + 1.000 passos, 1º quadro / tela estável (p50 ms, n=3)', `${x.partidaHistorico5000_primeiroQuadro_ms.p50} / ${x.partidaHistorico5000_telaEstavel_ms.p50}`);
    row('RSS ocioso (MB) · CPU ociosa (%)', `${x.ocioso?.rssMB} · ${x.ocioso?.cpuPct}`);
  }
  for (const k of ['stream20', 'stream50']) {
    const x = r[k];
    if (!x || x.erro) continue;
    const t = `${x.taxa}/s`;
    row(`Stream ${t}: digitação p50 / p95 / máx (ms) [perdidas]`, `${x.latenciaDigitacao_ms.p50} / ${x.latenciaDigitacao_ms.p95} / ${x.latenciaDigitacao_ms.max} [${x.latenciaDigitacao_ms.perdidas}/${x.latenciaDigitacao_ms.n}]`);
    row(`Stream ${t}: RSS mediana / máx / 1ª metade → 2ª metade (MB)`, `${x.rssMB.mediana} / ${x.rssMB.max} / ${x.rssMB.medianaPrimeiraMetade} → ${x.rssMB.medianaSegundaMetade}`);
    row(`Stream ${t}: CPU mediana / média / p95 (%)`, `${x.cpuPct.mediana} / ${x.cpuPct.media} / ${x.cpuPct.p95}`);
    row(`Stream ${t}: saída do pty (KB/s) · quadros sync/s`, `${round(x.saidaPty.bytesPorSegundo / 1024)} · ${x.saidaPty.quadrosSincronizadosPorSegundo}`);
    row(`Stream ${t}: limpezas/s (2J+J+K+2K) · 2J · J · K · 2K · cursor↑`, `${x.saidaPty.limpezasPorSegundo} · ${x.saidaPty.ED2_ESC_2J} · ${x.saidaPty.ED_ESC_J} · ${x.saidaPty.EL_ESC_K} · ${x.saidaPty.EL2_ESC_2K} · ${x.saidaPty.cursorUp}`);
    row(`Stream ${t}: amostras de tela com borda quebrada`, `${x.integridadeDuranteStream.comBordasQuebradas}/${x.integridadeDuranteStream.amostras}`);
  }
  if (r.history && !r.history.erro) {
    const x = r.history;
    row('Histórico: abertura, 1º quadro / tela estável (ms)', `${x.abertura.primeiroQuadro_ms} / ${x.abertura.telaEstavel_ms}`);
    for (const k of ['chat', 'painel', 'chat2']) row(`Histórico: PageUp/PageDown ${x[k].area} p50 / p95 / máx (ms) [perdidas]`, `${x[k].p50} / ${x[k].p95} / ${x[k].max} [${x[k].perdidas}/${x[k].n}]`);
    row('Histórico: RSS antes → depois / máx (MB), estável?', `${x.rssMB.antes} → ${x.rssMB.depois} / ${x.rssMB.max}, ${x.rssMB.estavel ? 'sim' : 'NÃO'}; RSS ao fim das rodadas 2 a 5: ${x.rssMB.rssFimDaRodada2a5 ? x.rssMB.rssFimDaRodada2a5.join(' → ') : 'n/d'} (patamar estável? ${x.rssMB.patamar ? 'sim' : 'NÃO'})`);
  }
  if (r.layout && !r.layout.erro) {
    const x = r.layout;
    row('Layout: passos com bordas inteiras', `${x.resumo.bordasOk}/${x.resumo.passos}`);
    row('Layout: passos com acentos e █/░ visíveis', `${x.resumo.acentosEBlocosOk}/${x.resumo.passos}`);
    row('Layout: Alt+B, Ctrl+B, Alt+J, Ctrl+J restauram o estado', `${x.teclasRestauram.altB_igual_ao_inicial && x.teclasRestauram.ctrlB_igual_ao_inicial ? 'lateral sim' : 'lateral NÃO'}; ${x.teclasRestauram.altJ_igual_ao_inicial && x.teclasRestauram.ctrlJ_igual_ao_inicial ? 'painel sim' : 'painel NÃO'}; Ctrl+←/→ ${x.teclasRestauram.ctrlRight_ctrlLeft_restauram ? 'sim' : 'NÃO'}`);
    if (x.resumo.passosComProblema.length) row('Layout: passos com problema', x.resumo.passosComProblema.map((p) => p.replace(/\|/g, '/')).join('<br>'));
  }
  return L.join('\n');
}

function tableMode(files) {
  const sums = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  for (const s of sums) console.log(mdTable(s) + '\n');
}

(async () => {
  summary.resultados = {};
  const run = async (key, fn) => {
    if (!only.includes(key)) return;
    log('>>', key);
    try {
      summary.resultados[key] = await fn();
    } catch (e) {
      summary.resultados[key] = { erro: String(e?.stack ?? e) };
      log('erro em', key, e);
    }
    try { await s.kill(); } catch { /* sessão já encerrada */ }
    save('summary.json', summary);
  };
  try {
    await tmux.start();
    await run('startup', () => scnStartup());
    await run('stream20', () => scnStream(20, DUR));
    await run('stream50', () => scnStream(50, DUR));
    await run('history', () => scnHistory());
    await run('layout', () => scnLayout());
  } finally {
    summary.fim = new Date().toISOString();
    summary.maquina.cargaNoFim = os.loadavg().map((x) => Math.round(x * 100) / 100);
    save('summary.json', summary);
    writeFileSync(resolve(OUT, 'summary.md'), mdTable(summary) + '\n');
    await tmux.stop();
  }
  console.log(mdTable(summary));
})();
