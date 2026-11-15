import React, { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize, type Key } from 'ink';
import { Badge, TextInput } from '@inkjs/ui';
import { trace } from './trace.js';
import { keyFlush } from './flush.js';
import { ChatModel, TrajModel, Store, clock, type Line, type Step } from './model.js';

export const SIDE_OPEN = 30;
export const SIDE_RAIL = 5;
export const CHAT_MIN = 30;
export const PANEL_MIN = 24;
export const PANEL_DEFAULT = 44;

export interface Layout { side: number; chat: number; panel: number }

/** Larguras das três colunas. O chat tem prioridade; o painel some quando não cabe. */
export function computeLayout(cols: number, sideOpen: boolean, panelOpen: boolean, chatW: number | null): Layout {
  const side = sideOpen ? SIDE_OPEN : SIDE_RAIL;
  const rest = Math.max(0, cols - side);
  if (panelOpen && rest >= CHAT_MIN + PANEL_MIN) {
    const want = chatW ?? rest - PANEL_DEFAULT;
    const chat = Math.min(rest - PANEL_MIN, Math.max(CHAT_MIN, want));
    return { side, chat, panel: rest - chat };
  }
  return { side, chat: rest, panel: 0 };
}

function useVersion(s: Store): number {
  return useSyncExternalStore(s.subscribe, s.getVersion);
}

const ROLE_COLOR = { you: 'yellow', orq: 'cyan', sys: 'gray' } as const;

/** Virtualização: só `height` linhas viram elementos; o resto fica no vetor `lines`. */
const ChatLines = memo(function ChatLines({ model, width, height, memoLines }: { model: ChatModel; width: number; height: number; memoLines: boolean }) {
  useVersion(model);
  model.setWidth(width);
  const total = model.lines.length;
  const off = Math.min(model.offset, Math.max(0, total - height));
  const end = total - off;
  const start = Math.max(0, end - height);
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) rows.push(memoLines ? <LineViewM key={i - start} l={model.lines[i]!} /> : <LineView key={i - start} l={model.lines[i]!} />);
  for (let i = rows.length; i < height; i++) rows.push(<Text key={`p${i}`}> </Text>);
  return <Box flexDirection="column" height={height} width={width} overflow="hidden">{rows}</Box>;
});

function LineView({ l }: { l: Line }) {
  if (l.kind === 'head') return (
    <Text wrap="truncate-end"><Text bold color={ROLE_COLOR[l.role]}>{l.text}</Text><Text dimColor> · {l.time}</Text></Text>
  );
  if (l.kind === 'blank') return <Text> </Text>;
  return <Text wrap="truncate-end">{l.text}{l.cursor ? <Text color="cyan">▌</Text> : null}</Text>;
}

/** --memo: linhas já quebradas não mudam (mesmo objeto) e não são reconciliadas de novo. */
const LineViewM = memo(LineView);

const STATUS_MARK = { ok: '✓', run: '▶', err: '✗' } as const;
const STATUS_COLOR = { ok: 'green', run: 'cyan', err: 'red' } as const;

const StepLines = memo(function StepLines({ model, width, height }: { model: TrajModel; width: number; height: number }) {
  useVersion(model);
  const total = model.steps.length;
  const off = Math.min(model.offset, Math.max(0, total - height));
  const end = total - off;
  const start = Math.max(0, end - height);
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) rows.push(<StepView key={i - start} s={model.steps[i]!} w={width} />);
  for (let i = rows.length; i < height; i++) rows.push(<Text key={`p${i}`}> </Text>);
  return <Box flexDirection="column" height={height} width={width} overflow="hidden">{rows}</Box>;
});

function StepView({ s, w }: { s: Step; w: number }) {
  const label = `${s.tool.padEnd(6)} ${s.text}`;
  const num = String(s.n).padStart(4);
  const room = Math.max(0, w - 7);
  const body = label.length > room ? label.slice(0, Math.max(0, room - 1)) + '…' : label;
  return <Text wrap="truncate-end"><Text color={STATUS_COLOR[s.status]}>{STATUS_MARK[s.status]}</Text><Text dimColor> {num} </Text>{body}</Text>;
}

const CEN: [string, string, string, string][] = [
  ['●', 'cyan', 'loja-api', '#14 exec'], ['!', 'yellow', 'relatorio-mensal', 'você'], ['✗', 'red', 'app-mobile', 'crít 2/2'],
  ['○', 'gray', 'pesquisa-acp', 'ocioso'], ['✓', 'green', 'migracao-db', '#9 ok'],
];
const SUBS: [string, number, string][] = [['cc/empresa', 62, 'green'], ['cc/pessoal', 91, 'yellow'], ['cx/conta-1', 34, 'green'], ['oc/minimax-api', 16, 'cyan'], ['oc/local', 50, 'cyan']];

function bar(w: number, p: number): [string, string] {
  const f = Math.round((w * p) / 100);
  return ['█'.repeat(f), '░'.repeat(w - f)];
}

const Side = memo(function Side({ open, height }: { open: boolean; height: number }) {
  if (!open) {
    return (
      <Box borderStyle="round" borderColor="gray" width={SIDE_RAIL} height={height} flexDirection="column" flexShrink={0} overflow="hidden">
        <Text color="cyan"> » </Text>
        {CEN.map(([m, c, n]) => <Text key={n}> <Text bold>{n[0]!.toUpperCase()}</Text><Text color={c}>{m}</Text></Text>)}
        {SUBS.map(([n, p, c]) => { const [a, b] = bar(3, p); return <Text key={n}> <Text color={c}>{a}</Text><Text dimColor>{b}</Text></Text>; })}
      </Box>
    );
  }
  const iw = SIDE_OPEN - 4;
  return (
    <Box borderStyle="round" borderColor="gray" width={SIDE_OPEN} height={height} flexDirection="column" paddingX={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end"><Text color="cyan">▾ </Text><Text dimColor>CENÁRIOS{' '.repeat(iw - 14)}</Text><Text color="cyan">« </Text><Text dimColor>^B</Text></Text>
      {CEN.map(([m, c, n, st], i) => (
        <Text key={n} wrap="truncate-end" inverse={i === 0}><Text color={c}>{m} </Text>{n.padEnd(15).slice(0, 15)}<Text dimColor>{st.padStart(iw - 17)}</Text></Text>
      ))}
      <Text> </Text>
      <Text><Text color="cyan">▾ </Text><Text dimColor>ASSINATURAS</Text></Text>
      {SUBS.map(([n, p, c]) => {
        const [a, b] = bar(iw, p);
        return (
          <Box key={n} flexDirection="column">
            <Text wrap="truncate-end">{n.padEnd(iw - 5)}<Text dimColor>{String(p).padStart(3)}%</Text></Text>
            <Text><Text color={c}>{a}</Text><Text dimColor>{b}</Text></Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text color="green">● <Text dimColor>daemon 127.0.0.1:7420</Text></Text>
    </Box>
  );
});

function InputLineBase({ width, kind, onSubmit }: { width: number; kind: 'own' | 'ui'; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('');
  useInput((input, key) => {
    if (kind !== 'own') return;
    if (input === 'Z') trace({ k: 'h' });
    handleKey(input, key);
    keyFlush();
  });
  const handleKey = (input: string, key: Key): void => {
    if (key.return) { if (text) onSubmit(text); setText(''); return; }
    if (key.backspace || key.delete) { setText((t) => t.slice(0, -1)); return; }
    if (key.ctrl || key.meta || key.tab || key.escape || key.pageUp || key.pageDown || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end) return;
    if (input === '\n') return; // Ctrl+J chega como LF: não é texto
    if (input) setText((t) => t + input);
  };
  if (kind === 'ui') {
    return (
      <Box width={width}>
        <Text color="cyan">› </Text>
        <TextInput placeholder="Fale com o Orquestrador…" onSubmit={onSubmit} />
      </Box>
    );
  }
  const room = width - 4;
  const shown = text.length > room ? text.slice(text.length - room) : text;
  return (
    <Text wrap="truncate-end"><Text color="cyan">› </Text>{shown}<Text inverse> </Text>{text ? '' : <Text dimColor> Fale com o Orquestrador…</Text>}</Text>
  );
}

const InputLineM = memo(InputLineBase);

function Header({ chat, columns, rows, scenario, rate, genDone }: { chat: ChatModel; columns: number; rows: number; scenario: string; rate: number; genDone: () => boolean }) {
  useVersion(chat); // chat.refresh() ao fim do gerador atualiza o selo
  return <Text wrap="truncate-end"><Text inverse color="cyan"> ◆ ot </Text><Text dimColor> │ </Text>loja-api › Peça #14 · Login OAuth <Text dimColor>│ </Text>{scenario === 'stream' ? <Badge color={genDone() || rate === 0 ? 'gray' : 'green'}>{genDone() ? 'fim' : rate === 0 ? 'ocioso' : `stream ${rate}/s`}</Badge> : <Badge color="blue">histórico</Badge>}<Text dimColor> │ {columns}x{rows}</Text></Text>;
}

function ChatTitle({ chat, chatMsgH, chatW }: { chat: ChatModel; chatMsgH: number; chatW: number }) {
  useVersion(chat);
  const off = Math.min(chat.offset, Math.max(0, chat.lines.length - chatMsgH));
  return <Text wrap="truncate-end"><Text bold>Chat · Orquestrador</Text><Text dimColor> ({chat.total} msgs{off > 0 ? ` · ↑ ${off} linhas` : ''}) ^←/→ {chatW} col</Text></Text>;
}

function TrajTitle({ traj }: { traj: TrajModel }) {
  useVersion(traj);
  return <Text wrap="truncate-end"><Text bold>Trajetória</Text><Text dimColor> ({traj.steps.length} passos{traj.offset > 0 ? ` · ↑ ${traj.offset}` : ''})</Text></Text>;
}

export interface AppProps { memoMode: boolean; chat: ChatModel; traj: TrajModel; inputKind: 'own' | 'ui'; scenario: string; rate: number; genDone: () => boolean }

type Focus = 'chat' | 'panel';

export function App({ memoMode, chat, traj, inputKind, scenario, rate, genDone }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [sideOpen, setSideOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [chatW, setChatW] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus>('chat');
  const lay = useMemo(() => computeLayout(columns, sideOpen, panelOpen, chatW), [columns, sideOpen, panelOpen, chatW]);
  const mainH = Math.max(6, rows - 2);
  // chat: borda(2) + título(1) + separador(1) + mensagens + separador(1) + entrada(1)
  const chatMsgH = Math.max(1, mainH - 6);
  const panelRowsH = Math.max(1, mainH - 4);
  const R = useRef({ lay, chatMsgH, panelRowsH, focus });
  R.current = { lay, chatMsgH, panelRowsH, focus };

  useInput((input, key) => {
    keyFlush();
    const ctrl = key.ctrl;
    const alt = key.meta && !ctrl;
    if (ctrl && input === 'q') { exit(); return; }
    if ((ctrl && input === 'b') || (alt && input === 'b')) { setSideOpen((v) => !v); return; }
    if ((ctrl && input === 'j') || input === '\n' || (alt && input === 'j')) { setPanelOpen((v) => !v); return; }
    if (ctrl && (key.leftArrow || key.rightArrow)) {
      setChatW(R.current.lay.chat + (key.rightArrow ? 4 : -4));
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === 'chat' && R.current.lay.panel > 0 ? 'panel' : 'chat'));
      return;
    }
    if (key.pageUp || key.pageDown) {
      const dir = key.pageUp ? 1 : -1;
      const r = R.current;
      if (r.focus === 'panel' && r.lay.panel > 0) traj.scroll(dir * Math.max(1, r.panelRowsH - 1), r.panelRowsH);
      else chat.scroll(dir * Math.max(1, r.chatMsgH - 1), r.chatMsgH);
    }
  });

  const iw = lay.chat - 4;
  const pw = lay.panel - 4;
  const onSubmit = useCallback((t: string) => { chat.add({ id: chat.msgs.length, role: 'you', time: clock(chat.msgs.length * 3), text: t }); chat.toBottom(); }, [chat]);
  const sep = '─'.repeat(Math.max(0, iw));
  if (!memoMode) { useVersion(chat); useVersion(traj); } // --memo: quem lê o Store assina o Store; o App não re-renderiza por tique
  const chatOff = memoMode ? 0 : Math.min(chat.offset, Math.max(0, chat.lines.length - chatMsgH));
  const hint = (k: string, t: string) => <Text key={k}><Text inverse> {k} </Text><Text dimColor> {t}  </Text></Text>;

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Box height={1} width={columns} overflow="hidden">
        {memoMode ? <Header chat={chat} columns={columns} rows={rows} scenario={scenario} rate={rate} genDone={genDone} /> : <Text wrap="truncate-end"><Text inverse color="cyan"> ◆ ot </Text><Text dimColor> │ </Text>loja-api › Peça #14 · Login OAuth <Text dimColor>│ </Text>{scenario === 'stream' ? <Badge color={genDone() || rate === 0 ? 'gray' : 'green'}>{genDone() ? 'fim' : rate === 0 ? 'ocioso' : `stream ${rate}/s`}</Badge> : <Badge color="blue">histórico</Badge>}<Text dimColor> │ {columns}x{rows}</Text></Text>}
      </Box>
      <Box height={mainH} width={columns} overflow="hidden">
        <Side open={sideOpen} height={mainH} />
        <Box borderStyle="round" borderColor={focus === 'chat' ? 'cyan' : 'gray'} width={lay.chat} height={mainH} flexDirection="column" paddingX={1} flexShrink={0} overflow="hidden">
          {memoMode ? <ChatTitle chat={chat} chatMsgH={chatMsgH} chatW={lay.chat} /> : <Text wrap="truncate-end"><Text bold>Chat · Orquestrador</Text><Text dimColor> ({chat.total} msgs{chatOff > 0 ? ` · ↑ ${chatOff} linhas` : ''}) ^←/→ {lay.chat} col</Text></Text>}
          <Text dimColor>{sep}</Text>
          <ChatLines model={chat} width={iw} height={chatMsgH} memoLines={memoMode} />
          <Text dimColor>{sep}</Text>
          {memoMode ? <InputLineM width={iw} kind={inputKind} onSubmit={onSubmit} /> : <InputLineBase width={iw} kind={inputKind} onSubmit={onSubmit} />}
        </Box>
        {lay.panel > 0 && (
          <Box borderStyle="round" borderColor={focus === 'panel' ? 'cyan' : 'gray'} width={lay.panel} height={mainH} flexDirection="column" paddingX={1} flexShrink={0} overflow="hidden">
            {memoMode ? <TrajTitle traj={traj} /> : <Text wrap="truncate-end"><Text bold>Trajetória</Text><Text dimColor> ({traj.steps.length} passos{traj.offset > 0 ? ` · ↑ ${traj.offset}` : ''})</Text></Text>}
            <Text dimColor>{'─'.repeat(Math.max(0, pw))}</Text>
            <StepLines model={traj} width={pw} height={panelRowsH} />
          </Box>
        )}
      </Box>
      <Box height={1} width={columns} overflow="hidden">
        <Text wrap="truncate-end">{hint('^B', 'lateral')}{hint('^J', 'painel')}{hint('^←→', 'largura')}{hint('Tab', 'foco')}{hint('PgUp/Dn', 'rolar')}{hint('^Q', 'sair')}</Text>
      </Box>
    </Box>
  );
}
