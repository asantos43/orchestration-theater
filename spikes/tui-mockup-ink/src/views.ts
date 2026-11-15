// Construção das linhas de cada região (funções puras: estado + tamanho -> linhas de segmentos coloridos).
// É aqui que mora a lógica de posição copiada do tui-render.js; os componentes Ink só desenham as linhas.
// Também é daqui que o script de conferência lê o texto (sem passar pelo Ink) quando precisa.
import {
  ATTEMPTS, BASE_HINTS, CEN, CHAT_TITLE, DAEMON, DECISION_OPTS, DECISION_TEXT, DEMANDAS, EVENTOS, FOCUS_HINTS, FONTES,
  GERAL_FOOT, PIECE_TITLE, PLACEHOLDER, ROLES, ROLES_FOOT, STEPS, SUBS, TAB_NAMES, TRAJ_FOOT, TRAJ_FOOT_LINE, TRAJ_HEAD,
  CONFIG_SUBS, type TabId,
} from './fixtures.js';
import { Canvas, bar, pad, rep, rpad, wbar, wrap, type Parts, type Row } from './text.js';
import { GERAL_SECTIONS, type Layout, type State } from './state.js';

const rows = (n: number, w: number, ox = 0) => Array.from({ length: Math.max(0, n) }, () => new Canvas(w, ox));
const toRows = (cs: Canvas[]): Row[] => cs.map(c => ({ parts: c.parts() }));
/** versão "selecionada" de uma célula: mesmo destaque do mockup (fundo da seleção) */
function selKey(k: string): string { return k.includes('acc') ? 'sel-acc' : k.includes('bold') ? 'tab-on' : 'sel'; }
function highlight(c: Canvas) { for (let i = 0; i < c.w; i++) c.k[i] = selKey(c.k[i] ?? ''); }

/* ------------------------------ cabeçalho e dicas ------------------------------ */
export function headerParts(cols: number, st: State): Parts {
  const c = new Canvas(cols, 0, 'hdr');
  const pending = st.decision.status !== 'done';
  c.seg(1, [
    [' ◆ ot ', 'hdr-k'], ['│ loja-api › Peça #14 · Login OAuth ', 'hdr'], ['│ ● Execução ', 'hdr'],
    pending ? ['│ ! 1 decisão ', 'hdr-k', 'dec:reopen'] : ['│ ✓ sem decisões ', 'hdr'],
  ]);
  if (cols >= 100) c.put(cols - DAEMON.length - 2, DAEMON, 'hdr'); // abaixo disso o texto da esquerda colidiria com ele
  return c.parts();
}

export function hintsParts(cols: number, st: State, lay: Layout): Parts {
  const c = new Canvas(cols);
  let X = 1;
  for (const [k, t] of lay.panelOpen || st.panelOpen ? BASE_HINTS : FOCUS_HINTS) {
    X = c.segX(X, [[' ' + k + ' ', 'key', 'hint:' + k], [' ' + t + '  ', 'hint', 'hint:' + k]]);
  }
  return c.parts();
}

/* ------------------------------ lateral ------------------------------ */
export function sideRows(h: number, st: State): Row[] {
  const n = h - 2;
  const fb = n - 4;
  const R = rows(Math.max(n, 40), 28, 1);
  const at = (y: number) => R[y - 2]!;
  let y = 2;
  at(y).seg(2, [['▾ ', 'acc'], ['CENÁRIOS', 'dim']]).put(27, '+', 'acc'); y++;
  CEN.forEach(([m, k, name, state], i) => {
    const sel = i === st.cur.cen, c = at(y);
    if (sel) c.fill(1, 28, 'sel');
    c.seg(2, [[sel ? '▸' : ' ', sel ? 'sel-acc' : ''], [' ' + m + ' ', sel ? 'sel-acc' : k], [pad(name, 15), sel ? 'sel' : ''], [rpad(state, 8), sel ? 'sel' : (k === 'dim' || k === 'ok' ? 'dim' : k)]]);
    c.hitAll('cen:' + i);
    y++;
  });
  y++;
  at(y).seg(2, [['▾ ', 'acc'], ['ASSINATURAS', 'dim']]).seg(17, [['█', 'dim'], ['5h ', 'dim'], ['━', 'dim'], ['7d', 'dim']]).put(27, '+', 'acc'); y++;
  for (const [name, label, p, k, wk] of SUBS) {
    const val = wk == null ? label : `${p}% · ${wk}%` + (k === 'warn' ? ' !' : '');
    at(y).put(2, pad(name, 15), '').put(17, rpad(val, 11), k === 'warn' ? 'warn' : 'dim');
    at(y + 1).seg(2, bar(26, p, k));
    y += 2;
    if (wk != null) { at(y).seg(2, wbar(26, wk, k)); y++; }
  }
  y++;
  at(y).seg(2, [['▸ ', 'acc'], ['PLUGINS (3)', 'dim']]);
  const out = toRows(R.slice(0, Math.max(0, fb)));
  const foot = rows(4, 28, 1);
  foot[0]!.put(1, rep('─', 28), 'b');
  foot[1]!.seg(2, [['⚙ ', 'acc'], [pad('Configurações', 22), 'bold'], ['F5', 'key']]);
  foot[2]!.seg(2, [['◫ ', 'acc'], [pad('Plugins', 22), ''], ['F6', 'key']]);
  foot[3]!.seg(2, [['● ', 'ok'], ['daemon 127.0.0.1:7420', 'dim']]);
  return [...out, ...toRows(foot)];
}

export function railRows(h: number, st: State): Row[] {
  const n = h - 2;
  const fb = n - 4;
  const R = rows(Math.max(n, 40), 3, 1);
  const at = (y: number) => R[y - 2]!;
  at(2).put(1, ' » ', 'acc', 'side:toggle');
  CEN.forEach(([m, k, , , letter], i) => {
    const sel = i === st.cur.cen, c = at(4 + i);
    if (sel) c.fill(1, 3, 'sel');
    c.seg(1, [[' ', sel ? 'sel' : ''], [letter, sel ? 'sel-acc' : 'bold'], [m, sel ? 'sel-acc' : k]]);
    c.hitAll('cen:' + i);
  });
  at(10).put(1, ' + ', 'acc');
  at(12).put(1, '───', 'b');
  let ry = 13;
  for (const [, , p, k, wk] of SUBS) {
    at(ry++).seg(1, bar(3, p, k));
    if (wk != null) at(ry++).seg(1, wbar(3, wk, k));
  }
  const out = toRows(R.slice(0, Math.max(0, fb)));
  const foot = rows(4, 3, 1);
  foot[0]!.put(1, '───', 'b');
  foot[1]!.put(1, ' ⚙ ', 'acc'); foot[2]!.put(1, ' ◫ ', 'acc'); foot[3]!.put(1, ' ● ', 'ok');
  return [...out, ...toRows(foot)];
}

/* ------------------------------ chat ------------------------------ */
export interface ChatView {
  iw: number; inner: number;
  head: Row[];         // título, status, separador
  area: Row[];         // mensagens (room linhas)
  gap: boolean;
  decision: null | { dw: number; dh: number; rows: Row[]; title: string };
  tail: Row[];         // linha em branco, separador, entrada, dicas
  bottomLabel: string;
  edgeY: number;
}

export function chatView(st: State, w: number, mainH: number, focusChat: boolean): ChatView {
  const iw = w - 4, inner = w - 2;
  const mk = () => new Canvas(inner, 1);
  const pending = st.decision.status !== 'done';
  // título e status
  const t = mk().put(2, pad(PIECE_TITLE, iw), 'bold');
  const sline = mk();
  if (iw >= 62) sline.seg(2, [['● Execução', 'acc'], [' · Crítico 0/2 · Plano 1/2 · 38 min · ', 'dim'], pending ? ['! 1 decisão', 'warn', 'dec:reopen'] : ['✓ sem decisões', 'ok']]);
  else sline.seg(2, [['● Execução', 'acc'], [' · 38 min · ', 'dim'], pending ? ['! 1 decisão', 'warn', 'dec:reopen'] : ['✓ sem decisões', 'ok']]);
  const sep = mk().put(1, rep('─', w - 2), 'b');

  // decisão pendente (logo acima da entrada)
  let decision: ChatView['decision'] = null;
  let dh = 0;
  if (st.decision.status === 'open') {
    const dw = Math.min(iw, 96), dText = wrap(DECISION_TEXT, dw - 4);
    dh = dText.length + 4;
    if (mainH - 10 - dh >= 2) {
      const c = new Canvas(dw - 2, 1);
      const dr: Canvas[] = dText.map(() => new Canvas(dw - 2, 1));
      dText.forEach((l, i) => dr[i]!.put(2, l, i < dText.length - 1 ? 'bold' : ''));
      const cur = st.decision.cursor;
      const opts: Parts = [
        [' 1 ', 'key', 'opt:0'], [' ' + DECISION_OPTS[0] + '  ', cur === 0 ? 'sel' : 'hint', 'opt:0'],
        [' 2 ', 'key', 'opt:1'], [' ' + DECISION_OPTS[1] + '  ', cur === 1 ? 'sel' : 'hint', 'opt:1'],
      ];
      if (dw >= 52) opts.push([' esc ', 'key', 'dec:later'], [' depois', 'hint', 'dec:later']);
      c.seg(2, opts);
      decision = { dw, dh, rows: [...dr, new Canvas(dw - 2, 1), c].map(x => ({ parts: x.parts() })), title: '! Decisão do Produtor · D2' };
    } else dh = 0;
  }
  const room = decision ? mainH - 10 - dh : mainH - 9;

  // mensagens: monta tudo e mostra o final (menos o deslocamento da roda)
  const L: Parts[] = [];
  st.msgs.forEach((m, i) => {
    if (m.kind === 'sys') { L.push([[m.time + ' ', 'dim'], [pad(m.who, 9), m.k ?? ''], [pad(m.text, iw - 15), 'dim']]); return; }
    if (L.length && L[L.length - 1]!.length && i > 0 && st.msgs[i - 1]!.kind === 'sys') L.push([]);
    L.push([[m.who, m.kind === 'you' ? 'you' : 'acc'], [' · ' + m.time, 'dim']]);
    wrap(m.text, iw).forEach(l => L.push([[l, '']]));
    L.push([]);
  });
  const maxScroll = Math.max(0, L.length - Math.max(room, 0));
  const scroll = Math.min(st.scroll, maxScroll);
  const end = L.length - scroll, start = Math.max(0, end - room);
  const shown = L.slice(start, end);
  const area = rows(Math.max(room, 0), inner, 1);
  shown.forEach((parts, i) => area[i]!.seg(2, parts));
  if (start > 0 && area[0]) area[0].put(w - 3, '▲', 'dim');
  if (scroll > 0 && area[room - 1]) area[room - 1]!.put(w - 3, '▼', 'dim');

  // entrada
  const inp = mk();
  const room2 = iw - 3;
  if (st.input) {
    const txt = st.input.length > room2 ? st.input.slice(st.input.length - room2) : st.input;
    inp.seg(2, [['› ', 'acc'], [txt, ''], [' ', focusChat ? 'cur' : '']]);
  } else inp.seg(2, [['› ', 'acc'], [' ', focusChat ? 'cur' : ''], [pad(PLACEHOLDER, iw - 3), 'dim']]);
  const hh = mk().seg(2, [['enter', 'key'], [' envia  ', 'hint'], ['/', 'key'], [' comandos  ', 'hint'], ['@', 'key'], [' arquivo', 'hint']]);
  const tail = [mk(), mk().put(1, rep('─', w - 2), 'b'), inp, hh];
  return {
    iw, inner,
    head: toRows([t, sline, sep]), area: toRows(area), gap: !!decision, decision,
    tail: toRows(tail), bottomLabel: ' ◂ ' + w + ' col ▸ ^←/^→ ', edgeY: Math.floor(mainH / 2) - 3,
  };
}

/* ------------------------------ painel de abas ------------------------------ */
const footParts = (items: [string, string][]): Parts =>
  items.flatMap(([k, t], i) => [[k, 'key'], [' ' + t + (i < items.length - 1 ? '  ' : ''), 'hint']] as Parts);

export interface PanelView { tabRow: Row; ulRow: Row; content: Row[]; foot: Row }

export function panelView(st: State, w: number, h: number): PanelView {
  const inner = w - 2, cw = w - 4;
  // linha de abas (+ sublinhado): coordenadas do mockup com a caixa em x = 0
  const tr = new Canvas(inner, 1), ur = new Canvas(inner, 1, 'b');
  ur.fill(1, w - 2, 'b', '─');
  const right: Parts = [['+', 'acc', 'new'], [' ^T  ', 'hint', 'new'], ['⟩', 'acc', 'hide'], [' ^J', 'hint', 'hide']];
  const rightLen = right.reduce((a, [s]) => a + s.length, 0);
  const avail = w - 4 - rightLen - 2;
  let names = st.tabs.map(id => TAB_NAMES[id]);
  const full = names.reduce((a, n) => a + n.length + 5, 0);
  if (full > avail) { const max = Math.max(5, Math.floor(avail / st.tabs.length) - 5); names = names.map(n => pad(n, max).trimEnd()); }
  let X = 2;
  st.tabs.forEach((id, i) => {
    const on = id === st.active, k = on ? 'tab-on' : 'dim', name = names[i]!;
    tr.put(X, ' ' + name + ' ', k, 'tab:' + id);
    tr.put(X + name.length + 2, '✕', k, 'x:' + id);
    tr.put(X + name.length + 3, ' ', k, 'tab:' + id);
    const len = name.length + 4;
    if (on) ur.put(X, rep('━', len), 'acc');
    X += len;
    tr.put(X, '│', 'b'); X += 1;
  });
  tr.seg(w - 2 - rightLen, right);

  const nrows = h - 5;
  const R = rows(nrows, cw);
  const id = st.active;
  let foot: Parts;
  if (id === 'geral') { geral(R, cw, st); foot = footParts(GERAL_FOOT); }
  else if (id === 'traj') { traj(R, cw, st); foot = footParts(TRAJ_FOOT); }
  else if (id === 'config') { config(R, cw, st); foot = footParts(ROLES_FOOT); }
  else { R[0]?.put(0, TAB_NAMES[id as TabId] + ' · (placeholder do spike: sem conteúdo no mockup)', 'dim'); foot = footParts(GERAL_FOOT.slice(1)); }
  const f = new Canvas(cw); f.seg(0, foot);
  return { tabRow: { parts: tr.parts() }, ulRow: { parts: ur.parts() }, content: toRows(R), foot: { parts: f.parts() } };
}

function sec(c: Canvas, w: number, title: string, open: boolean, right: string | undefined, key: string, cursor: boolean) {
  c.seg(0, [[open ? '▾ ' : '▸ ', 'acc'], [title, 'bold']]);
  if (right && title.length + right.length + 4 <= w) c.put(w - right.length, right, 'dim'); // largura pequena: o rótulo da direita some
  if (cursor) highlight(c);
  c.hitAll('sec:' + key);
}

function geral(R: Canvas[], w: number, st: State) {
  const col = (id: string) => !!st.collapsed['geral:' + id];
  const curOf = (id: string) => st.focus === 'panel' && GERAL_SECTIONS[st.cur.geral] === id;
  let y = 0;
  const at = (n: number) => R[n];
  const S = (id: string, title: string, right: string) => { const c = at(y); if (c) sec(c, w, title, !col(id), right, 'geral:' + id, curOf(id)); y++; };
  S('pipeline', 'Pipeline', 'iniciada 09:12');
  if (!col('pipeline')) {
    at(y++)?.put(2, '✓ Produtor ✓ Autor ✓ Dúvidas ✓ Revisor ✓ Roteiro', 'ok');
    at(y++)?.seg(2, [['✓ Autor ', 'ok'], ['▶ Execução 1/5', 'acc'], [' ○ Integr. ○ Crítico ○ PR', 'dim']]);
  }
  y++;
  S('demandas', 'Demandas (DAG)', 'sem conflito');
  if (!col('demandas')) for (const [m, k, n, e] of DEMANDAS) at(y++)?.seg(2, [[m + ' ', k], [pad(n, w - 17), k === 'dim' ? 'dim' : ''], [rpad(e, 13), e.includes('!') ? 'warn' : 'dim']]);
  y++;
  S('atores', 'Atores ativos · 2/4', 'RAM 6,1/16 GB');
  if (!col('atores')) {
    const a1 = at(y); a1?.seg(2, [['D2 ', 'bold'], [pad('cx/conta-1', 15), 'dim']]).seg(20, bar(w - 29, 60, 'acc')).put(w - 7, '18/30m', 'dim'); y++;
    at(y++)?.seg(2, [['   peca/14/D2/1 · ', 'dim'], ['aguarda decisão', 'warn']]);
    const a2 = at(y); a2?.seg(2, [['D3 ', 'bold'], [pad('cc/empresa', 15), 'dim']]).seg(20, bar(w - 29, 35, 'acc')).put(w - 7, ' 7/20m', 'dim'); y++;
    at(y++)?.seg(2, [['   peca/14/D3/1 · ', 'dim'], ['editando session.ts', 'acc']]);
  }
  y++;
  S('eventos', 'Eventos', '6 novos');
  if (!col('eventos')) for (const [t, text, k] of EVENTOS) at(y++)?.seg(2, [[t + ' ', 'dim'], [pad(text, w - 8), k]]);
  y++;
  S('cota', 'Cota por assinatura', '↻ reset · há 40 s');
  if (!col('cota')) {
    for (const [n, v, p, k, wk, r5, r7] of SUBS.slice(0, 4)) {
      const v5 = r5 ? `5h ${p}% ↻ ${r5}` + (k === 'warn' ? ' !' : '') : v;
      at(y)?.put(2, pad(n, 15), '').seg(17, bar(w - 36, p, k)).put(w - 18, pad(v5, 18), k === 'warn' ? 'warn' : 'dim'); y++;
      if (wk != null) { at(y)?.seg(17, wbar(w - 36, wk, k)).put(w - 18, pad(`7d ${wk}% ↻ ${r7}`, 18), 'dim'); y++; }
    }
  }
  y++;
  S('fontes', 'Fontes do sinal de cota', '3');
  if (!col('fontes')) for (const [n, how] of FONTES) at(y++)?.seg(2, [[pad(n, 15), ''], [pad(how, w - 17), 'dim']]);
}

function traj(R: Canvas[], w: number, st: State) {
  const lw = 26;
  const selA = st.cur.traj;
  ATTEMPTS.forEach(([a, b], i) => {
    const yy = i * 3, sel = i === selA;
    const c1 = R[yy], c2 = R[yy + 1];
    if (!c1 || !c2) return;
    if (sel) { c1.fill(0, lw - 1, 'sel'); c2.fill(0, lw - 1, 'sel'); }
    c1.seg(0, [[sel ? '▸ ' : '  ', sel ? 'sel-acc' : ''], [pad(a, lw - 3), sel ? 'sel' : 'bold']]);
    c2.put(2, pad(b, lw - 3), sel ? 'sel' : 'dim');
    c1.hitAll('att:' + i); c2.hitAll('att:' + i);
  });
  R[19]?.seg(0, [['e', 'key'], [' exportar ATIF', 'hint']]);
  for (let j = 0; j < R.length; j++) R[j]!.put(lw, '│', 'b');
  const sx = lw + 2, sw = w - lw - 2;
  if (selA !== 0) {
    R[0]?.seg(sx, [[ATTEMPTS[selA]![0], 'bold']]);
    R[2]?.put(sx, '(sem passos ilustrativos no mockup; só a D2 tem trajetória)', 'dim');
    return;
  }
  R[0]?.seg(sx, [[TRAJ_HEAD[0], 'bold'], [pad(TRAJ_HEAD[1], sw - 16), 'dim']]);
  let yy = 2;
  STEPS.forEach((s, i) => {
    const open = !!s.detail && !st.collapsed['traj:' + i];
    const c = R[yy++];
    if (c) { c.seg(sx, [[s.t + ' ', 'dim'], [open ? '▾ ' : '▸ ', 'acc'], [pad(s.kind, 9), s.kk], [pad(s.text, sw - 20), '']]); if (s.detail) c.hitAll('sec:traj:' + i); }
    if (open) s.detail!.forEach(([d, k]) => { const r = R[yy++]; r?.put(sx + 11, '│', 'b').put(sx + 13, pad(d, sw - 14), k); });
  });
  yy++;
  R[yy]?.seg(sx, [[TRAJ_FOOT_LINE[0], 'acc'], [TRAJ_FOOT_LINE[1], 'dim']]);
}

function config(R: Canvas[], w: number, st: State) {
  const c0 = R[0];
  if (c0) {
    let X = 0;
    CONFIG_SUBS.forEach((n, i) => { const on = i === st.cfgSub; X = c0.segX(X, [[' ' + n + ' ', on ? 'tab-on' : 'dim', 'cfgsub:' + i]]); X = c0.segX(X, [['│', 'b']]); });
    if (X + 16 <= w) c0.put(w - 14, 'escopo: global', 'dim');
  }
  if (st.cfgSub !== 2) { R[2]?.put(1, '(placeholder do spike: só a sub-aba Papéis tem conteúdo no mockup)', 'dim'); return; }
  const cw = w - 2;
  let yy = 2;
  ROLES.forEach((role, ri) => {
    const closed = !!st.collapsed['cfg:' + role.name];
    const hc = R[yy++];
    if (hc) {
      hc.seg(1, [[closed ? '▸ ' : '▾ ', 'acc'], [pad(role.name, cw - 14), 'bold'], [closed ? rpad(role.execs.length + ' executores', 12) : '', 'dim']]);
      if (st.focus === 'panel' && st.cur.cfg.role === ri && st.cur.cfg.idx === null) highlight(hc);
      hc.hitAll('sec:cfg:' + role.name);
    }
    if (!closed) {
      st.order[ri]!.forEach((ei, j) => {
        const [n, s] = role.execs[ei]!;
        const sel = st.cur.cfg.role === ri && st.cur.cfg.idx === j;
        const k = s === 'ok' ? 'ok' : s === 'inválido' ? 'err' : 'warn';
        const c = R[yy++];
        if (!c) return;
        if (sel) c.fill(1, cw, 'sel');
        const stt = s === 'ok' ? '✓' : s === 'inválido' ? '✗' : s === 'pool cheio' ? 'cheio' : s;
        c.seg(1, [[' ⋮', sel ? 'sel' : 'dim'], [(j + 1) + ' ', sel ? 'sel' : 'dim'], [pad(n, cw - 9), sel ? 'sel' : (s === 'inválido' ? 'dim' : '')], [rpad(stt, 5), sel ? 'sel-acc' : k]]);
        c.hitAll(`exec:${ri}:${j}`);
      });
      R[yy++]?.seg(1, [['   se esgotado: ', 'dim'], [st.rules[ri] === 'próximo' ? '[● próximo]' : '[● esperar]', 'acc']]);
    }
    yy++;
  });
}

export { type Row };
