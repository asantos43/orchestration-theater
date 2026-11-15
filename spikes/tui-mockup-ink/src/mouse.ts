// Mouse SGR (N34) e teclas de função, lidos por um "tap" no stdin ao lado do leitor do Ink.
//
// Por que um caminho próprio: o parser de entrada do Ink (build/input-parser.js + components/App.js) descarta
// sequências CSI completas que não viram tecla conhecida (o comentário do código cita mouse, foco e respostas
// de terminal), e useInput não entrega F2..F5 (input vem '' e o tipo Key não tem campo de função).
// O tap é um listener 'data' no process.stdin: com o listener 'readable' do Ink ativo, cada stdin.read() também
// emite 'data', então os dois leem os mesmos bytes sem um tirar do outro. O Ink continua vendo tudo (e descartando
// o que é mouse); o tap só olha.
import fs from 'node:fs';

export type MouseMode = 'full' | 'wheel' | 'off';

export type MouseEv =
  | { t: 'down' | 'up' | 'move'; x: number; y: number; b: number }
  | { t: 'wheel'; x: number; y: number; d: 1 | -1 };

export type FKey = 'F2' | 'F3' | 'F4' | 'F5' | 'F6';

const ON: Record<MouseMode, string> = {
  full: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  wheel: '\x1b[?1000h\x1b[?1006h',
  off: '',
};
const OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

let enabled = false;

export function enableMouse(mode: MouseMode): void {
  if (mode === 'off' || enabled) return;
  enabled = true;
  fs.writeSync(1, ON[mode]);
}

/** síncrono de propósito: roda em exit/SIGINT/uncaughtException, onde writes assíncronos se perdem */
export function disableMouse(): void {
  if (!enabled) return;
  enabled = false;
  try { fs.writeSync(1, OFF); } catch { /* terminal já fechou */ }
}

/** garante o desligamento em qualquer saída: exit, sinais e erros não tratados */
export function installMouseCleanup(): void {
  process.on('exit', disableMouse);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { disableMouse(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  process.on('uncaughtException', e => { disableMouse(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', e => { disableMouse(); console.error(e); process.exit(1); });
}

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const FKEYS: Record<string, FKey> = {
  '\x1bOQ': 'F2', '\x1b[12~': 'F2', '\x1bOR': 'F3', '\x1b[13~': 'F3', '\x1bOS': 'F4', '\x1b[14~': 'F4', '\x1b[15~': 'F5', '\x1b[17~': 'F6',
};
const FRE = /\x1bO[QRS]|\x1b\[1[2-5]~|\x1b\[17~/g;
/** cauda de uma sequência que pode estar partida entre dois chunks: ESC, ESC [, ESC O ou ESC [ < dígitos; */
const TAIL = /\x1b(?:\[(?:<[\d;]*)?|O)?$/;

export interface Sink { mouse(e: MouseEv): void; fkey(k: FKey): void }

/**
 * Extrai de `s` os eventos de mouse e as teclas de função (entregues ao sink) e devolve o que sobrou.
 * `keep` indica a cauda que deve esperar o próximo chunk (a cauda não faz parte do texto devolvido).
 */
export function scan(s: string, sink: Sink): { rest: string; tail: string } {
  let tail = '';
  const m = TAIL.exec(s);
  if (m) { tail = m[0]; s = s.slice(0, m.index); }
  for (const e of s.matchAll(SGR)) {
    const b = Number(e[1]), x = Number(e[2]) - 1, y = Number(e[3]) - 1, press = e[4] === 'M';
    if (b & 64) { sink.mouse({ t: 'wheel', x, y, d: (b & 1) ? 1 : -1 }); continue; }
    const motion = (b & 32) !== 0, btn = b & 3;
    if (motion) sink.mouse({ t: 'move', x, y, b: btn });
    else sink.mouse({ t: press ? 'down' : 'up', x, y, b: btn });
  }
  for (const f of s.matchAll(FRE)) { const k = FKEYS[f[0]]; if (k) sink.fkey(k); }
  return { rest: s.replace(SGR, '').replace(FRE, ''), tail };
}

/** Modo "tap": só espia o stdin real (o Ink continua lendo tudo; ele descarta o que é mouse). */
export function tapStdin(stdin: NodeJS.EventEmitter, sink: Sink): () => void {
  let carry = '';
  const handler = (chunk: Buffer | string) => {
    const r = scan(carry + (typeof chunk === 'string' ? chunk : chunk.toString('latin1')), sink);
    carry = r.tail;
  };
  stdin.on('data', handler);
  return () => { stdin.off('data', handler); };
}
