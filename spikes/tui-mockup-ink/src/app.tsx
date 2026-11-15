import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import type { EventEmitter } from 'node:events';
import { useApp, useInput, useWindowSize } from 'ink';
import { appendFileSync } from 'node:fs';
import { RegistryProvider, Registry } from './hit.js';
import { View } from './view.js';
import { reducer, initial, computeLayout, type Action, type ScreenId, type State } from './state.js';
import type { FKey, MouseEv, MouseMode } from './mouse.js';
import { filterCommands } from './commands.js';
import { TAB_ORDER, type TabId } from './fixtures.js';

const FPRESET: Partial<Record<FKey, ScreenId>> = { F2: 'main', F3: 'traj', F4: 'config', F5: 'focus' };
const clickable = /^(handle|side:toggle|tab:|x:|new$|hide$|sec:|opt:|dec:|cen:|att:|exec:|cfgsub:|hint:|pane:)/;

export function App({ screen, mouse, bus }: { screen: ScreenId; mouse: MouseMode; bus: EventEmitter }) {
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [st, dispatch] = useReducer(reducer, undefined, () => initial(screen, mouse));
  const stRef = useRef(st); stRef.current = st;
  const size = useRef({ columns, rows }); size.current = { columns, rows };
  const reg = useMemo(() => new Registry(), []);
  const dragging = useRef(false);

  const run = (a: Action | { t: 'quit' }) => { if (a.t === 'quit') exit(); else dispatch(a); };

  /* ---------- mouse e teclas de função (vêm do barramento de src/input.ts) ---------- */
  useEffect(() => {
    const hint = (k: string) => {
      switch (k) {
        case '^B': return dispatch({ t: 'toggleSide' });
        case '^J': return dispatch({ t: 'togglePanel' });
        case '^T': return dispatch({ t: 'openTab' });
        case '^W': return dispatch({ t: 'closeTab' });
        case 'Tab': return dispatch({ t: 'focusNext' });
        case 'F5': return dispatch({ t: 'openTab', id: 'config' });
        case '^K': return dispatch({ t: 'palette', op: 'open' });
        case '^Q': return exit();
      }
    };
    const act = (id: string, e: MouseEv): boolean => {
      const [base = '', ...rest] = id.split('#')[0]!.split(':');
      const arg = rest.join(':');
      switch (base) {
        case 'handle': dragging.current = true; return true;
        case 'side': dispatch({ t: 'toggleSide' }); return true;
        case 'tab': dispatch({ t: 'activate', id: arg as TabId }); dispatch({ t: 'focus', pane: 'panel' }); return true;
        case 'x': dispatch({ t: 'closeTab', id: arg as TabId }); return true;
        case 'new': dispatch({ t: 'openTab' }); return true;
        case 'hide': dispatch({ t: 'togglePanel' }); return true;
        case 'sec': dispatch({ t: 'toggleSection', id: arg }); dispatch({ t: 'focus', pane: 'panel' }); return true;
        case 'opt': dispatch({ t: 'decision', op: 'pick', n: Number(arg) }); return true;
        case 'dec': dispatch({ t: 'decision', op: arg === 'later' ? 'later' : 'reopen' }); return true;
        case 'cen': dispatch({ t: 'cen', i: Number(arg) }); dispatch({ t: 'focus', pane: 'side' }); return true;
        case 'att': dispatch({ t: 'setCur', which: 'traj', i: Number(arg) }); dispatch({ t: 'focus', pane: 'panel' }); return true;
        case 'exec': { const [r, j] = arg.split(':').map(Number); dispatch({ t: 'cfgCursor', role: r!, idx: j! }); dispatch({ t: 'focus', pane: 'panel' }); return true; }
        case 'cfgsub': dispatch({ t: 'cfgSub', i: Number(arg) }); return true;
        case 'hint': hint(arg); return true;
        case 'pane': dispatch({ t: 'focus', pane: arg as 'chat' | 'panel' | 'side' }); return true;
      }
      void e;
      return false;
    };
    const onMouse = (e: MouseEv) => {
      if (process.env['OTM_DEBUG']) appendFileSync(process.env['OTM_DEBUG'], JSON.stringify({ e, hits: reg.at(e.x, e.y).map(h => h.id), reg: e.t === 'down' ? reg.dump() : undefined }) + '\n');
      if (mouse === 'off' || stRef.current.palette.open) return;
      if (e.t === 'wheel') {
        if (reg.at(e.x, e.y).some(h => h.id.startsWith('wheel:chat'))) dispatch({ t: 'scroll', d: e.d > 0 ? -3 : 3 });
        return;
      }
      if (mouse === 'wheel') return;
      if (e.t === 'down' && e.b === 0) {
        for (const h of reg.at(e.x, e.y)) if (clickable.test(h.id) && act(h.id, e)) break;
      } else if (e.t === 'move' && dragging.current) {
        const chat = reg.get('pane:chat');
        if (chat) dispatch({ t: 'chatW', abs: e.x - chat.x + 1 });
      } else if (e.t === 'up') dragging.current = false;
    };
    const onFKey = (k: FKey) => {
      const p = FPRESET[k];
      if (p) dispatch({ t: 'preset', id: p });
      else if (k === 'F6') dispatch({ t: 'openTab', id: 'plugins' });
    };
    bus.on('mouse', onMouse).on('fkey', onFKey);
    return () => { bus.off('mouse', onMouse).off('fkey', onFKey); };
  }, [bus, reg, mouse, exit]);

  /* ---------- teclado (useInput do Ink) ---------- */
  useInput((input, key) => {
    if (process.env['OTM_DEBUG']) appendFileSync(process.env['OTM_DEBUG'], JSON.stringify({ input }) + '\n');
    const s = stRef.current;
    if (s.palette.open) {
      const items = filterCommands(s.palette.q);
      const sel = Math.min(s.palette.sel, Math.max(0, items.length - 1));
      if (key.escape || (key.ctrl && input === 'k')) dispatch({ t: 'palette', op: 'close' });
      else if (key.return) { const c = items[sel]; dispatch({ t: 'palette', op: 'close' }); if (c) run(c.act); }
      else if (key.upArrow) dispatch({ t: 'palette', op: 'move', d: -1 });
      else if (key.downArrow) dispatch({ t: 'palette', op: 'move', d: 1 });
      else if (key.backspace || key.delete) dispatch({ t: 'palette', op: 'back' });
      else if (input && !key.ctrl && !key.meta) dispatch({ t: 'palette', op: 'type', ch: input });
      return;
    }
    // atalhos globais
    const ctrl = key.ctrl, alt = key.meta;
    if (ctrl && input === 'q') return exit();
    if (ctrl && input === 'k') return dispatch({ t: 'palette', op: 'open' });
    if ((ctrl || alt) && input === 'b') return dispatch({ t: 'toggleSide' });
    if (((ctrl || alt) && input === 'j') || input === '\n') return dispatch({ t: 'togglePanel' });
    if (ctrl && input === 't') return dispatch({ t: 'openTab' });
    if (ctrl && input === 'w') return dispatch({ t: 'closeTab' });
    if (ctrl && key.leftArrow) return dispatch({ t: 'chatW', delta: -2 });
    if (ctrl && key.rightArrow) return dispatch({ t: 'chatW', delta: 2 });
    if (key.tab) return dispatch({ t: 'focusNext' });
    if (key.pageUp) return dispatch({ t: 'scroll', d: 5 });
    if (key.pageDown) return dispatch({ t: 'scroll', d: -5 });
    if (ctrl || alt) return;

    if (s.focus === 'chat') {
      const decOpen = s.decision.status === 'open' && s.input === '';
      if (decOpen) {
        if (input === '1' || input === '2') return dispatch({ t: 'decision', op: 'pick', n: Number(input) - 1 });
        if (key.upArrow) return dispatch({ t: 'decision', op: 'move', n: -1 });
        if (key.downArrow) return dispatch({ t: 'decision', op: 'move', n: 1 });
        if (key.return && s.decision.cursor >= 0) return dispatch({ t: 'decision', op: 'pick' });
        if (key.escape) return dispatch({ t: 'decision', op: 'later' });
      }
      if (key.return) return dispatch({ t: 'send' });
      if (key.backspace || key.delete) return dispatch({ t: 'backspace' });
      if (key.upArrow) return dispatch({ t: 'scroll', d: 1 });
      if (key.downArrow) return dispatch({ t: 'scroll', d: -1 });
      if (input && !key.escape) for (const ch of input) if (ch >= ' ') dispatch({ t: 'type', ch });
      return;
    }
    if (s.focus === 'panel') {
      if (key.upArrow) return dispatch(key.shift ? { t: 'reorder', d: -1 } : { t: 'move', d: -1 });
      if (key.downArrow) return dispatch(key.shift ? { t: 'reorder', d: 1 } : { t: 'move', d: 1 });
      if (key.return) return dispatch({ t: 'enter' });
      if (key.leftArrow || key.rightArrow) {
        const i = s.tabs.indexOf(s.active), n = s.tabs.length;
        return dispatch({ t: 'activate', id: s.tabs[(i + (key.rightArrow ? 1 : n - 1)) % n]! });
      }
      if (input === 'r') return dispatch({ t: 'rule' });
      if (key.escape) return dispatch({ t: 'focus', pane: 'chat' });
      return;
    }
    if (s.focus === 'side') {
      if (key.upArrow) return dispatch({ t: 'move', d: -1 });
      if (key.downArrow) return dispatch({ t: 'move', d: 1 });
      if (key.escape) return dispatch({ t: 'focus', pane: 'chat' });
    }
  });

  void TAB_ORDER; void computeLayout;
  return (
    <RegistryProvider value={reg}>
      <View st={st as State} cols={columns} rows={rows} />
    </RegistryProvider>
  );
}
