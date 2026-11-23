// Gerador do mockup da TUI. Rode: node tui-render.cjs  → reescreve tui.html (telas pré-renderizadas, funcionam sem JavaScript).
// É .cjs porque o package.json da raiz tem "type": "module" (como .js, o require falha).
// Mesmo layout do app: chat em altura total com largura ajustável, lateral retrátil, painel de abas que abrem e fecham, seções recolhíveis.
const fs = require('fs');
const path = require('path');

const W = 140, H = 42;
let G;
function reset() { G = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ c: ' ', k: '' }))); }
function put(x, y, s, k = '') { if (y < 0 || y >= H) return; for (let i = 0; i < s.length; i++) { const X = x + i; if (X < 0 || X >= W) continue; G[y][X] = { c: s[i], k }; } }
function fill(x, y, w, k, ch = ' ') { for (let i = 0; i < w; i++) put(x + i, y, ch, k); }
function recolor(x, y, w, k) { for (let i = 0; i < w; i++) if (G[y] && G[y][x + i]) G[y][x + i].k = k; }
function pad(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s.padEnd(n); }
function rpad(s, n) { s = String(s); return s.length > n ? s.slice(0, n) : s.padStart(n); }
function seg(x, y, parts) { let X = x; for (const [s, k] of parts) { put(X, y, s, k || ''); X += s.length; } return X; }
function bar(x, y, w, p, k = 'ok') { const f = Math.round(w * p / 100); put(x, y, '█'.repeat(f), k); put(x + f, y, '░'.repeat(w - f), 'dim'); }
function box(x, y, w, h, title, on) {
  const k = on ? 'b-on' : 'b';
  put(x, y, '╭' + '─'.repeat(w - 2) + '╮', k);
  for (let j = 1; j < h - 1; j++) { put(x, y + j, '│', k); put(x + w - 1, y + j, '│', k); }
  put(x, y + h - 1, '╰' + '─'.repeat(w - 2) + '╯', k);
  if (title) { const t = title.length > w - 6 ? pad(title, w - 6) : title; put(x + 2, y, ' ' + t + ' ', on ? 'ti-on' : 'ti'); }
}
function wrap(t, w) {
  const out = []; let line = '';
  for (const word of t.split(' ')) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= w) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}
function hints(items) {
  fill(0, H - 1, W, ''); let X = 1;
  for (const [k, t] of items) X = seg(X, H - 1, [[' ' + k + ' ', 'key'], [' ' + t + '  ', 'hint']]);
}
function header() {
  fill(0, 0, W, 'hdr');
  seg(1, 0, [[' ◆ ot ', 'hdr-k'], ['│ loja-api › Peça #14 · Login OAuth ', 'hdr'], ['│ ● Execução ', 'hdr'], ['│ ! 1 decisão ', 'hdr-k']]);
  const r = 'daemon 127.0.0.1:7420 ●';
  put(W - r.length - 2, 0, r, 'hdr');
}

/* ---------------- lateral ---------------- */
const CEN = [
  ['●', 'acc', 'loja-api', '#14 exec', 'L', true],
  ['!', 'warn', 'relatorio-mensal', 'você', 'R'],
  ['✗', 'err', 'app-mobile', 'crít 2/2', 'A'],
  ['○', 'dim', 'pesquisa-acp', 'ocioso', 'P'],
  ['✓', 'ok', 'migracao-db', '#9 ok', 'M'],
];
// [nome, rótulo, % da janela de 5 h, cor, % da janela de 7 dias (null = sem cota semanal), reset de 5 h, reset de 7 dias]
const SUBS = [['cc/empresa', '5h 62%', 62, 'ok', 31, '11:30', 'ter 09:00'], ['cc/pessoal', '5h 91% !', 91, 'warn', 58, '10:05', 'seg 14:20'], ['cx/conta-1', '5h 34%', 34, 'ok', 22, '12:10', 'qui 21:00'], ['oc/minimax-api', 'US$ 3,20', 16, 'acc', null], ['oc/local', '1/2 slots', 50, 'acc', null]];
// barra fina da semana: traço cheio na cor da assinatura (esmaecida) e trilho escuro
function wbar(x, y, w, p, k) { const f = Math.round(w * p / 100); put(x, y, '━'.repeat(f), k + ' wk'); put(x + f, y, '─'.repeat(w - f), 'b'); }

function sideExpanded() {
  box(0, 1, 30, 40, 'Navegação', false);
  seg(22, 1, [[' « ', 'acc'], ['^B', 'key'], [' ', 'b']]);
  let y = 2;
  seg(2, y, [['▾ ', 'acc'], ['CENÁRIOS', 'dim']]); put(27, y, '+', 'acc'); y++;
  for (const [m, k, name, st, , sel] of CEN) {
    if (sel) fill(1, y, 28, 'sel');
    seg(2, y, [[sel ? '▸' : ' ', sel ? 'sel-acc' : ''], [' ' + m + ' ', sel ? 'sel-acc' : k], [pad(name, 15), sel ? 'sel' : ''], [rpad(st, 8), sel ? 'sel' : (k === 'dim' || k === 'ok' ? 'dim' : k)]]);
    y++;
  }
  y++;
  seg(2, y, [['▾ ', 'acc'], ['ASSINATURAS', 'dim']]); seg(17, y, [['█', 'dim'], ['5h ', 'dim'], ['━', 'dim'], ['7d', 'dim']]); put(27, y, '+', 'acc'); y++;
  for (const [n, v, p, k, wk] of SUBS) {
    const val = wk == null ? v : `${p}% · ${wk}%` + (k === 'warn' ? ' !' : '');
    put(2, y, pad(n, 15), ''); put(17, y, rpad(val, 11), k === 'warn' ? 'warn' : 'dim'); bar(2, y + 1, 26, p, k); y += 2;
    if (wk != null) { wbar(2, y, 26, wk, k); y++; }
  }
  y++;
  seg(2, y, [['▸ ', 'acc'], ['PLUGINS (3)', 'dim']]); y++;
  put(1, 36, '─'.repeat(28), 'b');
  seg(2, 37, [['⚙ ', 'acc'], [pad('Configurações', 22), 'bold'], ['F5', 'key']]);
  seg(2, 38, [['◫ ', 'acc'], [pad('Plugins', 22), ''], ['F6', 'key']]);
  seg(2, 39, [['● ', 'ok'], ['daemon 127.0.0.1:7420', 'dim']]);
}
function sideRail() {
  box(0, 1, 5, 40, '', false);
  put(1, 2, ' » ', 'acc');
  CEN.forEach(([m, k, , , letter, sel], i) => {
    const y = 4 + i;
    if (sel) fill(1, y, 3, 'sel');
    seg(1, y, [[' ', sel ? 'sel' : ''], [letter, sel ? 'sel-acc' : 'bold'], [m, sel ? 'sel-acc' : k]]);
  });
  put(1, 10, ' + ', 'acc');
  put(1, 12, '───', 'b');
  { let ry = 13; for (const [, , p, k, wk] of SUBS) { bar(1, ry++, 3, p, k); if (wk != null) wbar(1, ry++, 3, wk, k); } }
  put(1, 36, '───', 'b');
  put(1, 37, ' ⚙ ', 'acc');
  put(1, 38, ' ◫ ', 'acc');
  put(1, 39, ' ● ', 'ok');
}

/* ---------------- chat (altura total) ---------------- */
const MSGS = [
  ['you', 'você', '09:12', 'Quero login OAuth com Google e GitHub na API, com testes de ponta a ponta. Pode abrir PR no final.'],
  ['orq', 'diretor', '09:12', 'Entendido. Abri a peça #14 no projeto loja-api e mandei a necessidade para o Autor. Aviso quando o plano passar pelo Revisor.'],
  ['sys', '09:19', 'autor', 'Opus · alto entregou o plano (7 passos)', 'ok'],
  ['sys', '09:23', 'revisor', 'Codex · alto aprovou na 1ª tentativa', 'ok'],
  ['sys', '09:27', 'roteiro', '5 demandas · D2 e D3 em paralelo', 'ok'],
  ['sys', '09:41', 'ator', 'D1 concluída por codex-sol-high@codex/conta-1', 'sys'],
  ['sys', '09:42', 'seleção', 'D3: codex-sol-high@codex/conta-1 sem vaga → claude-sonnet-medium@claude-code/empresa', 'warn'],
  ['orq', 'diretor', '09:42', 'D1 pronta. D2 (fluxo OAuth) e D3 (middleware de sessão) estão rodando em worktrees separadas. D4 (testes e2e) começa quando as duas terminarem.'],
];
function chat(x, w) {
  box(x, 1, w, 40, 'Chat · Orquestrador (claude-haiku-low@claude-code/empresa)', true);
  const ix = x + 2, iw = w - 4;
  put(ix, 2, pad('Peça #14 · Login OAuth (Google e GitHub) na API', iw), 'bold');
  if (iw >= 62) seg(ix, 3, [['● Execução', 'acc'], [' · Crítico 0/2 · Plano 1/2 · 38 min · ', 'dim'], ['! 1 decisão', 'warn']]);
  else seg(ix, 3, [['● Execução', 'acc'], [' · 38 min · ', 'dim'], ['! 1 decisão', 'warn']]);
  put(x + 1, 4, '─'.repeat(w - 2), 'b');

  // decisão pendente, logo acima da entrada
  const dw = Math.min(iw, 96), dText = wrap('O Ator da D2 precisa de credenciais de teste do Google para validar o callback. Uso um mock do provedor agora ou espero você configurar?', dw - 4);
  const dh = dText.length + 4, dTop = 36 - dh;
  box(ix, dTop, dw, dh, '', false);
  for (let j = 0; j < dh; j++) { recolor(ix, dTop + j, 1, 'warn'); recolor(ix + dw - 1, dTop + j, 1, 'warn'); }
  recolor(ix, dTop, dw, 'warn'); recolor(ix, dTop + dh - 1, dw, 'warn');
  put(ix + 2, dTop, ' ! Decisão do Produtor · D2 ', 'warn');
  dText.forEach((l, i) => put(ix + 2, dTop + 1 + i, l, i < dText.length - 1 ? 'bold' : ''));
  const opts = [[' 1 ', 'key'], [' Usar mock  ', 'hint'], [' 2 ', 'key'], [' Vou configurar  ', 'hint']];
  if (dw >= 52) opts.push([' esc ', 'key'], [' depois', 'hint']);
  seg(ix + 2, dTop + dh - 2, opts);

  // mensagens: monta tudo e mostra o final (rolagem no fim)
  const L = [];
  for (const m of MSGS) {
    if (m[0] === 'sys') { L.push([[m[1] + ' ', 'dim'], [pad(m[2], 9), m[4]], [pad(m[3], iw - 15), 'dim']]); continue; }
    if (L.length && L[L.length - 1].length && MSGS.indexOf(m) > 0 && MSGS[MSGS.indexOf(m) - 1][0] === 'sys') L.push([]);
    L.push([[m[1], m[0] === 'you' ? 'you' : 'acc'], [' · ' + m[2], 'dim']]);
    wrap(m[3], iw).forEach(l => L.push([[l, '']]));
    L.push([]);
  }
  const top = 5, room = dTop - 1 - top;
  const shown = L.slice(Math.max(0, L.length - room));
  if (L.length > room) { put(x + w - 3, top, '▲', 'dim'); }
  shown.forEach((parts, i) => seg(ix, top + i, parts));

  // entrada
  put(x + 1, 37, '─'.repeat(w - 2), 'b');
  seg(ix, 38, [['› ', 'acc'], [' ', 'cur'], [pad(' Fale com o Orquestrador…', iw - 3), 'dim']]);
  seg(ix, 39, [['enter', 'key'], [' envia  ', 'hint'], ['/', 'key'], [' comandos  ', 'hint'], ['@', 'key'], [' arquivo', 'hint']]);
  // alça de largura
  for (let j = 18; j <= 23; j++) put(x + w - 1, j, '┃', 'acc');
  const lab = ' ◂ ' + w + ' col ▸ ^←/^→ ';
  put(x + w - lab.length - 2, 40, lab, 'acc');
}

/* ---------------- painel de abas ---------------- */
const TABS = { geral: 'Visão geral', traj: 'Trajetórias', consumo: 'Consumo', config: 'Configurações', plugins: 'Plugins' };
function panel(x, w, open, active, content, foot) {
  box(x, 1, w, 40, '', false);
  const right = [['+', 'acc'], [' ^T  ', 'hint'], ['⟩', 'acc'], [' ^J', 'hint']];
  const rightLen = right.reduce((a, [s]) => a + s.length, 0);
  const avail = w - 4 - rightLen - 2;
  let names = open.map(id => TABS[id]);
  const full = names.reduce((a, n) => a + n.length + 5, 0);
  if (full > avail) { const max = Math.max(5, Math.floor(avail / open.length) - 5); names = names.map(n => pad(n, max).trimEnd()); }
  let X = x + 2;
  open.forEach((id, i) => {
    const on = id === active, label = ' ' + names[i] + ' ✕ ';
    put(X, 2, label, on ? 'tab-on' : 'dim');
    if (on) put(X, 3, '━'.repeat(label.length), 'acc');
    X += label.length;
    put(X, 2, '│', 'b'); X += 1;
  });
  seg(x + w - 2 - rightLen, 2, right);
  for (let i = x + 1; i < x + w - 1; i++) if (G[3][i].c === ' ') put(i, 3, '─', 'b');
  content(x + 2, 4, w - 4);
  if (foot) seg(x + 2, 39, foot);
}
function sec(x, y, w, title, open, right) {
  seg(x, y, [[open ? '▾ ' : '▸ ', 'acc'], [title, 'bold']]);
  if (right) put(x + w - right.length, y, right, 'dim');
  return y + 1;
}

function tabGeral(x, y, w) {
  y = sec(x, y, w, 'Pipeline', true, 'iniciada 09:12');
  put(x + 2, y++, '✓ Produtor ✓ Autor ✓ Dúvidas ✓ Revisor ✓ Roteiro', 'ok');
  seg(x + 2, y++, [['✓ Autor ', 'ok'], ['▶ Execução 1/5', 'acc'], [' ○ Integr. ○ Crítico ○ PR', 'dim']]);
  y++;
  y = sec(x, y, w, 'Demandas (DAG)', true, 'sem conflito');
  const dem = [['✓', 'ok', 'D1 Usuário e migração', 'codex-sol-high@codex/conta-1'], ['▶', 'acc', 'D2 Fluxo OAuth · 18/30m', 'codex-sol-high@codex/conta-1 !'], ['▶', 'acc', 'D3 Middleware · 7/20m', 'claude-sonnet-medium@claude-code/empresa'], ['○', 'dim', 'D4 Testes e2e ← D2, D3', ''], ['○', 'dim', 'D5 Documentação · fila', '']];
  for (const [m, k, n, e] of dem) seg(x + 2, y++, [[m + ' ', k], [pad(n, w - 17), k === 'dim' ? 'dim' : ''], [rpad(e, 13), e.includes('!') ? 'warn' : 'dim']]);
  y++;
  y = sec(x, y, w, 'Atores ativos · 2/4', true, 'RAM 6,1/16 GB');
  seg(x + 2, y, [['D2 ', 'bold'], [pad('cx/conta-1', 15), 'dim']]); bar(x + 20, y, w - 29, 60, 'acc'); put(x + w - 7, y++, '18/30m', 'dim');
  seg(x + 2, y++, [['   peca/14/D2/1 · ', 'dim'], ['aguarda decisão', 'warn']]);
  seg(x + 2, y, [['D3 ', 'bold'], [pad('cc/empresa', 15), 'dim']]); bar(x + 20, y, w - 29, 35, 'acc'); put(x + w - 7, y++, ' 7/20m', 'dim');
  seg(x + 2, y++, [['   peca/14/D3/1 · ', 'dim'], ['editando session.ts', 'acc']]);
  y++;
  y = sec(x, y, w, 'Eventos', false, '6 novos');
  y++;
  y = sec(x, y, w, 'Cota por assinatura', true, '↻ reset · há 40 s');
  // coluna de valores com 18 posições: "7d 31% ↻ ter 09:00"
  for (const [n, v, p, k, wk, r5, r7] of SUBS.slice(0, 4)) {
    const v5 = r5 ? `5h ${p}% ↻ ${r5}` + (k === 'warn' ? ' !' : '') : v;
    put(x + 2, y, pad(n, 15), ''); bar(x + 17, y, w - 36, p, k); put(x + w - 18, y++, pad(v5, 18), k === 'warn' ? 'warn' : 'dim');
    if (wk != null) { wbar(x + 17, y, w - 36, wk, k); put(x + w - 18, y++, pad(`7d ${wk}% ↻ ${r7}`, 18), 'dim'); }
  }
  y++;
  y = sec(x, y, w, 'Fontes do sinal de cota', false, '3');
}

function tabTraj(x, y, w) {
  const lw = 26;
  const at = [['D2 · tentativa 1', 'codex-sol-high@codex/conta-1 · 46 passos', true], ['D3 · tentativa 1', 'claude-sonnet-medium@claude-code/empresa · 21'], ['D1 · tentativa 1', 'concluída'], ['Roteirista', 'concluída'], ['Revisor', 'concluída'], ['Autor', 'concluída']];
  at.forEach(([a, b, sel], i) => {
    const yy = y + i * 3;
    if (sel) { fill(x, yy, lw - 1, 'sel'); fill(x, yy + 1, lw - 1, 'sel'); }
    seg(x, yy, [[sel ? '▸ ' : '  ', sel ? 'sel-acc' : ''], [pad(a, lw - 3), sel ? 'sel' : 'bold']]);
    put(x + 2, yy + 1, pad(b, lw - 3), sel ? 'sel' : 'dim');
  });
  seg(x, y + 19, [['e', 'key'], [' exportar ATIF', 'hint']]);
  for (let j = y; j < 39; j++) put(x + lw, j, '│', 'b');
  const sx = x + lw + 2, sw = w - lw - 2;
  seg(sx, y, [['D2 · Fluxo OAuth', 'bold'], [pad(' · 182k entrada (71% cache) · 9,4k saída', sw - 16), 'dim']]);
  let yy = y + 2;
  const st = (t, k, kk, txt, open) => { seg(sx, yy++, [[t + ' ', 'dim'], [open ? '▾ ' : '▸ ', 'acc'], [pad(k, 9), kk], [pad(txt, sw - 20), '']]); };
  st('09:42:30', 'contexto', 'sys', 'regras → papel ator → contrato C-2 → demanda D2');
  st('09:42:41', 'read', 'acc', 'src/models/user.ts · 86 linhas');
  st('09:42:44', 'mcp', 'ok', 'ler_contrato("C-2")');
  st('09:43:02', 'edit', 'acc', 'src/auth/oauth.ts  +118 −0', true);
  ['+ export class OAuthService {', '+   constructor(private providers, private users) {}', "+   authorize(provider: 'google' | 'github', state): URL { … }", '+   async callback(provider, code, state): Promise<Session>', '+ }'].forEach(d => { put(sx + 11, yy, '│', 'b'); put(sx + 13, yy++, pad(d, sw - 14), 'add'); });
  st('09:43:20', 'casca', 'ok', 'install_deps() · fila de pesados (2º) · 14 s · ok');
  st('09:43:52', 'mcp', 'warn', 'perguntar_produtor("credenciais do Google")');
  st('09:44:10', 'casca', 'err', 'run_tests("auth") → 11 ok, 1 falha', true);
  ['✗ oauth.callback › google › troca código por token', '  GOOGLE_CLIENT_ID ausente no ambiente de teste', '  saída truncada pela casca: 1.204 → 40 linhas'].forEach((d, i) => { put(sx + 11, yy, '│', 'b'); put(sx + 13, yy++, pad(d, sw - 14), i ? 'dim' : 'err'); });
  st('09:44:30', 'edit', 'acc', 'tests/auth/github.e2e.ts  +64 −0');
  yy++;
  seg(sx, yy, [['● em curso', 'acc'], [' · 18/30 min · WIP automático no timeout', 'dim']]);
}

function tabConfig(x, y, w) {
  let X = x;
  for (const [n, on] of [['Assinaturas'], ['Executores'], ['Papéis', true], ['Limites']]) {
    X = seg(X, y, [[' ' + n + ' ', on ? 'tab-on' : 'dim']]); X = seg(X, y, [['│', 'b']]);
  }
  if (X + 16 <= x + w) put(x + w - 14, y, 'escopo: global', 'dim');
  y += 2;
  const R = [
    ['Diretor (Orquestrador)', [['claude-haiku-low@claude-code/empresa', 'ok'], ['codex-luna-low@codex/conta-1', 'ok'], ['gemma4-low@opencode/local', 'ok']], 'próximo'],
    ['Autor', [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], 'próximo'],
    ['Revisor', [['codex-sol-high@codex/conta-1', 'ok'], ['claude-opus-high@claude-code/empresa', 'ok']], 'próximo'],
    ['Roteirista', [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], 'próximo', true],
    ['Ator', [['codex-sol-high@codex/conta-1', 'pool cheio'], ['claude-sonnet-medium@claude-code/empresa', 'ok'], ['minimax-m2-medium@opencode/minimax-api', 'ok'], ['codex-luna-medium@codex-pessoal', 'inválido']], 'próximo'],
    ['Crítico', [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], 'esperar'],
  ];
  const cw = w - 2;
  const ys = [y];
  R.forEach(([t, ex, rule, closed], i) => {
    const c = 0, cx = x + 1;
    let yy = ys[c];
    seg(cx, yy++, [[closed ? '▸ ' : '▾ ', 'acc'], [pad(t, cw - 14), 'bold'], [closed ? rpad(ex.length + ' executores', 12) : '', 'dim']]);
    if (!closed) {
      ex.forEach(([n, s], j) => {
        const sel = t === 'Ator' && j === 1, k = s === 'ok' ? 'ok' : s === 'inválido' ? 'err' : 'warn';
        if (sel) fill(cx, yy, cw, 'sel');
        const st = s === 'ok' ? '✓' : s === 'inválido' ? '✗' : s === 'pool cheio' ? 'cheio' : s;
        seg(cx, yy++, [[' ⋮', sel ? 'sel' : 'dim'], [(j + 1) + ' ', sel ? 'sel' : 'dim'], [pad(n, cw - 9), sel ? 'sel' : (s === 'inválido' ? 'dim' : '')], [rpad(st, 5), sel ? 'sel-acc' : k]]);
      });
      seg(cx, yy++, [['   se esgotado: ', 'dim'], [rule === 'próximo' ? '[● próximo]' : '[● esperar]', 'acc']]);
    }
    ys[c] = yy + 1;
  });
}

function rolesFoot() { return [['⇧↑↓', 'key'], [' reordenar  ', 'hint'], ['r', 'key'], [' regra  ', 'hint'], ['s', 'key'], [' salvar  ', 'hint'], ['enter', 'key'], [' recolher', 'hint']]; }
function geralFoot() { return [['enter', 'key'], [' recolher/expandir seção  ', 'hint'], ['^W', 'key'], [' fechar aba', 'hint']]; }

/* ---------------- telas ---------------- */
const BASE_HINTS = [['^B', 'Lateral'], ['^J', 'Painel'], ['^←/^→', 'Largura do chat'], ['^T', 'Abrir aba'], ['^W', 'Fechar aba'], ['Tab', 'Foco'], ['F5', 'Config'], ['^K', 'Comandos'], ['^Q', 'Sair']];
const SCREENS = {
  main: { label: 'Principal', desc: 'Lateral aberta · chat 56 col · aba Visão geral com seções recolhidas', draw() {
    reset(); header(); sideExpanded(); chat(30, 56);
    panel(86, 54, ['geral', 'traj', 'consumo'], 'geral', tabGeral, geralFoot());
    hints(BASE_HINTS);
  } },
  traj: { label: 'Trajetórias', desc: 'Lateral recolhida (^B) · chat estreitado para 50 col · aba Trajetórias', draw() {
    reset(); header(); sideRail(); chat(5, 50);
    panel(55, 85, ['geral', 'traj', 'consumo'], 'traj', tabTraj, [['enter', 'key'], [' expandir passo  ', 'hint'], ['f', 'key'], [' filtrar  ', 'hint'], ['d', 'key'], [' diff  ', 'hint'], ['F', 'key'], [' seguir ao vivo', 'hint']]);
    hints(BASE_HINTS);
  } },
  config: { label: 'Configurações', desc: 'Configurações aberta como aba (F5) · sub-aba Papéis · Consumo fechada', draw() {
    reset(); header(); sideExpanded(); chat(30, 46);
    panel(76, 64, ['geral', 'traj', 'config'], 'config', tabConfig, rolesFoot());
    hints(BASE_HINTS);
  } },
  focus: { label: 'Só o chat', desc: 'Painel fechado (^J) e lateral recolhida (^B): o chat ocupa a tela toda', draw() {
    reset(); header(); sideRail(); chat(5, 135);
    hints([['^J', 'Reabrir painel'], ['^B', 'Lateral'], ['^T', 'Abrir aba'], ['F5', 'Config'], ['^K', 'Comandos'], ['^Q', 'Sair']]);
  } },
};

/* ---------------- render ---------------- */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function render() {
  return G.map(row => {
    let line = '', cur = null, buf = '';
    const flush = () => { if (buf) line += cur ? '<span class="' + cur + '">' + esc(buf) + '</span>' : esc(buf); buf = ''; };
    for (const c of row) { if (c.k !== cur) { flush(); cur = c.k; } buf += c.c; }
    flush(); return line;
  }).join('\n');
}

const keys = Object.keys(SCREENS);
const sections = keys.map((id, i) => {
  SCREENS[id].draw();
  const s = SCREENS[id];
  return `<section class="screen${i === 0 ? ' on' : ''}" data-s="${id}"><h2>F${i + 2} · ${s.label} <span>${s.desc}</span></h2><p class="desc">${s.desc}</p><div class="wrap">
  <div class="chrome"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>ot — loja-api — 140×42</span></div>
  <pre class="term" aria-label="Tela ${s.label} da TUI">${render()}</pre>
</div></section>`;
}).join('\n');
const buttons = keys.map((id, i) => `<button data-s="${id}"${i === 0 ? ' class="on"' : ''}>F${i + 2} · ${SCREENS[id].label}</button>`).join('\n    ');

const page = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OTheater · TUI</title>
<!-- Gerado por tui-render.cjs. Não edite à mão: altere o gerador e rode "node tui-render.cjs". -->
<style>
:root{--bg:#eef0f3;--text:#1b1f24;--muted:#5d6672;--line:#d3d8df;--panel:#fff;--accent:#4a5bd4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0d10;--text:#e6e8ec;--muted:#9aa3af;--line:#2a303a;--panel:#14171d;--accent:#8190ff}}
:root[data-theme="dark"]{--bg:#0b0d10;--text:#e6e8ec;--muted:#9aa3af;--line:#2a303a;--panel:#14171d;--accent:#8190ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif;padding:20px 16px}
header{max-width:1100px;margin:0 auto 12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:17px;margin:0}
header p{margin:0;color:var(--muted);font-size:13px}
.switch{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.switch button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:5px 11px;cursor:pointer}
.switch button.on{border-color:var(--accent);color:var(--accent);font-weight:600}
.screen{max-width:1100px;margin:0 auto 24px}
.screen h2{font-size:13px;color:var(--text);margin:0 0 6px;font-weight:650}
.screen h2 span{font-weight:400;color:var(--muted);margin-left:6px}
.screen .desc{display:none;margin:0 0 8px;color:var(--muted);font-size:13px}
html.js .screen{display:none}
html.js .screen.on{display:block}
html.js .screen h2{display:none}
html.js .screen .desc{display:block}
.wrap{overflow-x:auto;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.chrome{background:#2b2f37;padding:7px 12px;display:flex;gap:7px;align-items:center;border-radius:10px 10px 0 0;min-width:max-content}
.chrome i{width:11px;height:11px;border-radius:50%;display:inline-block}
.chrome span{color:#aeb4bf;font:12px "Segoe UI",sans-serif;margin-left:10px}
/* A fonte do painel de terminal do Claude desktop (xterm.js: Menlo, Monaco, "Courier New", monospace; 13 px; altura da linha da própria fonte), para comparar com a TUI de verdade. */
pre.term{margin:0;background:#11141a;color:#c9ced6;font:13px/normal Menlo,Monaco,"Courier New",monospace;padding:10px 12px;min-width:max-content;border-radius:0 0 10px 10px}
.b{color:#3a4150}.b-on{color:#7d8cff}.ti{color:#e6e8ec;font-weight:700}.ti-on{color:#aab4ff;font-weight:700}
.dim{color:#6b7380}.wk{opacity:.6}.acc{color:#8f9cff}.ok{color:#4fc98f}.warn{color:#e8a948}.err{color:#ef6b6b}.sys{color:#b4a6ff}
.you{color:#7cc4ff;font-weight:700}.bold{color:#e6e8ec;font-weight:700}
.hdr{background:#3a46a8;color:#fff}.hdr-k{background:#3a46a8;color:#ffd479;font-weight:700}
.sel{background:#232a44;color:#fff}.sel-acc{background:#232a44;color:#8f9cff}
.tab-on{background:#232a44;color:#fff;font-weight:700}
.key{background:#2b3140;color:#ffd479;font-weight:700}.hint{color:#9aa3af}
.cur{background:#c9ced6;color:#11141a}
.add{color:#4fc98f}.del{color:#ef6b6b}
.note{max-width:1100px;margin:12px auto 0;color:var(--muted);font-size:12.5px}
.note code{font-family:Consolas,monospace;font-size:12px}
</style>
</head>
<body>
<header>
  <div><h1>OTheater · mockup da TUI</h1><p>Cliente de terminal da mesma API do daemon (Ink). Mesmo layout do app: chat em altura total, lateral retrátil, painel de abas.</p></div>
  <div class="switch" id="sw">
    ${buttons}
    <button id="theme" title="Alternar tema da página">◐</button>
  </div>
</header>
${sections}
<p class="note">Atalhos da TUI: <code>Alt+S</code> recolhe a lateral · <code>Alt+J</code> abre/fecha o painel · <code>Ctrl+Shift+←/→</code> ajusta a largura do chat (lembrada entre sessões) · <code>Alt+A</code>/<code>Alt+W</code> abrem e fecham abas · <code>Alt+K</code> ou <code>F1</code> abre a paleta (atalhos da v0.33, N35) · <code>Enter</code> no título recolhe uma seção · <code>F5</code> abre Configurações como aba. Telas pré-renderizadas (aparecem mesmo sem JavaScript); para alterá-las, edite <code>tui-render.cjs</code> e rode <code>node tui-render.cjs</code>. Valores ilustrativos, os mesmos do mockup do app. Baseado em <code>arquitetura.md</code> v0.4.</p>
<script>
(function(){
  const root=document.documentElement;root.classList.add("js");
  function go(s){document.querySelectorAll(".screen").forEach(x=>x.classList.toggle("on",x.dataset.s===s));document.querySelectorAll("#sw [data-s]").forEach(b=>b.classList.toggle("on",b.dataset.s===s));}
  document.querySelectorAll("#sw [data-s]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.s)));
  const KEYS=${JSON.stringify(Object.fromEntries(keys.map((k, i) => ['F' + (i + 2), k])))};
  document.addEventListener("keydown",e=>{const m=KEYS[e.key];if(m){e.preventDefault();go(m);}});
  document.getElementById("theme").addEventListener("click",()=>{const dark=root.dataset.theme?root.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;root.dataset.theme=dark?"light":"dark";});
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, 'tui.html'), page);
console.log('telas geradas:', keys.join(', '));
