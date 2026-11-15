// Estado da TUI e reducer. Só dados serializáveis; o que vem do daemon (fixtures) fica fora.
import { CEN, MSGS, ROLES, STEPS, TAB_ORDER, type Msg, type TabId } from './fixtures.js';

export type ScreenId = 'main' | 'traj' | 'config' | 'focus';
export type Pane = 'chat' | 'panel' | 'side';
export type MouseMode = 'full' | 'wheel' | 'off';

export const SIDE_OPEN = 30, SIDE_RAIL = 5, CHAT_MIN = 30, PANEL_MIN = 24;

export interface State {
  screen: ScreenId;
  sideOpen: boolean;
  panelOpen: boolean;
  chatW: number;
  tabs: TabId[];
  active: TabId;
  focus: Pane;
  decision: { status: 'open' | 'later' | 'done'; cursor: number; choice: number | null };
  /** seções recolhidas: 'geral:eventos', 'cfg:Roteirista', 'traj:3'; true = recolhida */
  collapsed: Record<string, boolean>;
  /** cursor por aba */
  cur: { geral: number; traj: number; cen: number; cfg: { role: number; idx: number | null } };
  /** ordem dos executores por papel (índices em ROLES[r].execs) */
  order: number[][];
  rules: ('próximo' | 'esperar')[];
  cfgSub: number;
  input: string;
  msgs: Msg[];
  scroll: number;
  palette: { open: boolean; q: string; sel: number };
  mouse: MouseMode;
  toast: string;
}

export const GERAL_SECTIONS = ['pipeline', 'demandas', 'atores', 'eventos', 'cota', 'fontes'] as const;

export const PRESETS: Record<ScreenId, { side: boolean; panel: boolean; chatW: number; tabs: TabId[]; active: TabId }> = {
  main: { side: true, panel: true, chatW: 56, tabs: ['geral', 'traj', 'consumo'], active: 'geral' },
  traj: { side: false, panel: true, chatW: 50, tabs: ['geral', 'traj', 'consumo'], active: 'traj' },
  config: { side: true, panel: true, chatW: 46, tabs: ['geral', 'traj', 'config'], active: 'config' },
  focus: { side: false, panel: false, chatW: 135, tabs: ['geral', 'traj', 'consumo'], active: 'geral' },
};

export function initial(screen: ScreenId = 'main', mouse: MouseMode = 'full'): State {
  const p = PRESETS[screen];
  const collapsed: Record<string, boolean> = { 'geral:eventos': true, 'geral:fontes': true };
  ROLES.forEach(r => { if (r.closed) collapsed['cfg:' + r.name] = true; });
  STEPS.forEach((s, i) => { if (s.detail && !s.open) collapsed['traj:' + i] = true; if (s.detail && s.open) collapsed['traj:' + i] = false; });
  return {
    screen, sideOpen: p.side, panelOpen: p.panel, chatW: p.chatW, tabs: [...p.tabs], active: p.active,
    focus: 'chat',
    decision: { status: 'open', cursor: -1, choice: null },
    collapsed,
    cur: { geral: 0, traj: 0, cen: 0, cfg: { role: ROLES.findIndex(r => r.name === 'Ator'), idx: 1 } },
    order: ROLES.map(r => r.execs.map((_, i) => i)),
    rules: ROLES.map(r => r.rule),
    cfgSub: 2,
    input: '', msgs: MSGS, scroll: 0,
    palette: { open: false, q: '', sel: 0 },
    mouse, toast: '',
  };
}

export interface Layout { side: number; chat: number; panel: number; panelOpen: boolean; autoRail: boolean; mainH: number }

/** Larguras das três colunas para o tamanho do terminal; degrada em telas estreitas (lateral vira trilho, depois o painel some). */
export function computeLayout(s: State, cols: number, rows: number): Layout {
  let sideOpen = s.sideOpen, autoRail = false;
  let panelOpen = s.panelOpen;
  if (panelOpen && sideOpen && cols - SIDE_OPEN < CHAT_MIN + PANEL_MIN) { sideOpen = false; autoRail = true; }
  const side = sideOpen ? SIDE_OPEN : SIDE_RAIL;
  if (panelOpen && cols - side < CHAT_MIN + PANEL_MIN) panelOpen = false;
  let chat: number, panel = 0;
  if (panelOpen) { chat = Math.max(CHAT_MIN, Math.min(s.chatW, cols - side - PANEL_MIN)); panel = cols - side - chat; }
  else chat = cols - side;
  return { side, chat, panel, panelOpen, autoRail, mainH: Math.max(6, rows - 2) };
}

/* ---- cursor da aba Configurações: lista plana de (papel, executor|cabeçalho) ---- */
export function cfgItems(s: State): { role: number; idx: number | null }[] {
  const out: { role: number; idx: number | null }[] = [];
  ROLES.forEach((r, ri) => {
    out.push({ role: ri, idx: null });
    if (!s.collapsed['cfg:' + r.name]) r.execs.forEach((_, j) => out.push({ role: ri, idx: j }));
  });
  return out;
}

export type Action =
  | { t: 'preset'; id: ScreenId }
  | { t: 'toggleSide' } | { t: 'togglePanel' }
  | { t: 'chatW'; delta?: number; abs?: number }
  | { t: 'openTab'; id?: TabId } | { t: 'closeTab'; id?: TabId } | { t: 'activate'; id: TabId }
  | { t: 'focusNext' } | { t: 'focus'; pane: Pane }
  | { t: 'toggleSection'; id: string }
  | { t: 'move'; d: number } | { t: 'enter' } | { t: 'reorder'; d: number } | { t: 'rule' }
  | { t: 'decision'; op: 'move' | 'pick' | 'later' | 'reopen'; n?: number }
  | { t: 'type'; ch: string } | { t: 'backspace' } | { t: 'send' }
  | { t: 'scroll'; d: number }
  | { t: 'cen'; i: number }
  | { t: 'cfgSub'; i: number }
  | { t: 'setCur'; which: 'geral' | 'traj'; i: number }
  | { t: 'cfgCursor'; role: number; idx: number | null }
  | { t: 'palette'; op: 'open' | 'close' | 'type' | 'back' | 'move'; ch?: string; d?: number }
  | { t: 'toast'; text: string };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'preset': {
      const p = PRESETS[a.id];
      return { ...s, screen: a.id, sideOpen: p.side, panelOpen: p.panel, chatW: p.chatW, tabs: [...p.tabs], active: p.active, focus: 'chat' };
    }
    case 'toggleSide': return { ...s, sideOpen: !s.sideOpen };
    case 'togglePanel': return { ...s, panelOpen: !s.panelOpen, focus: s.focus === 'panel' && s.panelOpen ? 'chat' : s.focus };
    case 'chatW': {
      const v = a.abs ?? s.chatW + (a.delta ?? 0);
      return { ...s, chatW: clamp(Math.round(v), CHAT_MIN, 400) };
    }
    case 'activate': return { ...s, active: a.id, panelOpen: true };
    case 'openTab': {
      if (a.id) return s.tabs.includes(a.id) ? { ...s, active: a.id, panelOpen: true } : { ...s, tabs: [...s.tabs, a.id], active: a.id, panelOpen: true };
      const next = TAB_ORDER.find(t => !s.tabs.includes(t));
      if (!next) return { ...s, panelOpen: true };
      return { ...s, tabs: [...s.tabs, next], active: next, panelOpen: true };
    }
    case 'closeTab': {
      const id = a.id ?? s.active;
      const i = s.tabs.indexOf(id);
      if (i < 0) return s;
      const tabs = s.tabs.filter(t => t !== id);
      if (!tabs.length) return { ...s, tabs, panelOpen: false, focus: s.focus === 'panel' ? 'chat' : s.focus };
      const active = id === s.active ? tabs[Math.min(i, tabs.length - 1)]! : s.active;
      return { ...s, tabs, active };
    }
    case 'focus': return { ...s, focus: a.pane };
    case 'focusNext': {
      const order: Pane[] = ['chat', ...(s.panelOpen ? ['panel' as Pane] : []), 'side'];
      return { ...s, focus: order[(order.indexOf(s.focus) + 1) % order.length]! };
    }
    case 'toggleSection': return { ...s, collapsed: { ...s.collapsed, [a.id]: !s.collapsed[a.id] } };
    case 'cen': return { ...s, cur: { ...s.cur, cen: a.i } };
    case 'cfgSub': return { ...s, cfgSub: a.i };
    case 'setCur': return { ...s, cur: { ...s.cur, [a.which]: a.i } };
    case 'cfgCursor': return { ...s, cur: { ...s.cur, cfg: { role: a.role, idx: a.idx } } };
    case 'move': {
      if (s.focus === 'side') return { ...s, cur: { ...s.cur, cen: clamp(s.cur.cen + a.d, 0, CEN.length - 1) } };
      if (s.focus !== 'panel') return s;
      if (s.active === 'geral') return { ...s, cur: { ...s.cur, geral: clamp(s.cur.geral + a.d, 0, GERAL_SECTIONS.length - 1) } };
      if (s.active === 'traj') return { ...s, cur: { ...s.cur, traj: clamp(s.cur.traj + a.d, 0, 5) } };
      if (s.active === 'config') {
        const items = cfgItems(s);
        const at = items.findIndex(it => it.role === s.cur.cfg.role && it.idx === s.cur.cfg.idx);
        const n = items[clamp((at < 0 ? 0 : at) + a.d, 0, items.length - 1)]!;
        return { ...s, cur: { ...s.cur, cfg: n } };
      }
      return s;
    }
    case 'enter': {
      if (s.focus === 'panel') {
        if (s.active === 'geral') return reducer(s, { t: 'toggleSection', id: 'geral:' + GERAL_SECTIONS[s.cur.geral] });
        if (s.active === 'config') return reducer(s, { t: 'toggleSection', id: 'cfg:' + ROLES[s.cur.cfg.role]!.name });
        return s;
      }
      if (s.focus === 'side') return s;
      return s;
    }
    case 'reorder': {
      if (s.active !== 'config' || s.cur.cfg.idx == null) return s;
      const { role, idx } = s.cur.cfg;
      const j = idx + a.d;
      const ord = s.order[role]!;
      if (j < 0 || j >= ord.length) return s;
      const o = [...ord];
      [o[idx], o[j]] = [o[j]!, o[idx]!];
      const order = s.order.map((x, i) => (i === role ? o : x));
      return { ...s, order, cur: { ...s.cur, cfg: { role, idx: j } } };
    }
    case 'rule': {
      if (s.active !== 'config') return s;
      const r = s.cur.cfg.role;
      return { ...s, rules: s.rules.map((x, i) => (i === r ? (x === 'próximo' ? 'esperar' : 'próximo') : x)) };
    }
    case 'decision': {
      if (a.op === 'reopen') return { ...s, decision: { ...s.decision, status: 'open' } };
      if (s.decision.status !== 'open') return s;
      if (a.op === 'later') return { ...s, decision: { ...s.decision, status: 'later' } };
      if (a.op === 'move') return { ...s, decision: { ...s.decision, cursor: s.decision.cursor < 0 ? (a.n! > 0 ? 0 : 1) : clamp(s.decision.cursor + a.n!, 0, 1) } };
      // pick
      const n = a.n ?? s.decision.cursor;
      if (n < 0 || n > 1) return s;
      const text = n === 0 ? 'D2: mock do provedor (Produtor escolheu "Usar mock")' : 'D2: aguarda credenciais (Produtor escolheu "Vou configurar")';
      return { ...s, decision: { status: 'done', cursor: n, choice: n }, msgs: [...s.msgs, { kind: 'sys', who: 'produtor', time: '09:45', text, k: 'ok' }], scroll: 0 };
    }
    case 'type': return { ...s, input: s.input + a.ch };
    case 'backspace': return { ...s, input: s.input.slice(0, -1) };
    case 'send': {
      if (!s.input.trim()) return s;
      return { ...s, input: '', scroll: 0, msgs: [...s.msgs, { kind: 'you', who: 'você', time: '09:46', text: s.input.trim() }] };
    }
    case 'scroll': return { ...s, scroll: Math.max(0, s.scroll + a.d) };
    case 'palette': {
      const p = s.palette;
      if (a.op === 'open') return { ...s, palette: { open: true, q: '', sel: 0 } };
      if (a.op === 'close') return { ...s, palette: { ...p, open: false } };
      if (a.op === 'type') return { ...s, palette: { ...p, q: p.q + (a.ch ?? ''), sel: 0 } };
      if (a.op === 'back') return { ...s, palette: { ...p, q: p.q.slice(0, -1), sel: 0 } };
      return { ...s, palette: { ...p, sel: Math.max(0, p.sel + (a.d ?? 0)) } };
    }
    case 'toast': return { ...s, toast: a.text };
  }
}
