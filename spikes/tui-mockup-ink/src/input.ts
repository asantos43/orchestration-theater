// Entrada do spike: como o mouse e as teclas F2..F6 chegam ao app sem brigar com o leitor de entrada do Ink.
//
// Dois modos (flag --input), para comparar:
//   filter (padrão): o app lê o stdin real, tira dele o mouse SGR e as teclas de função, e entrega ao Ink só o resto,
//                    por um stream intermediário (PassThrough com isTTY/setRawMode/ref repassados ao stdin real).
//                    O Ink nunca vê uma sequência de mouse, então nada vaza como texto, mesmo se ela chegar partida.
//   tap:             o Ink lê o stdin real; o app só espia com um listener 'data'. O Ink descarta as CSI completas que
//                    não conhece, mas uma sequência SGR partida entre dois chunks vaza como texto (ver README).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { scan, tapStdin, type FKey, type MouseEv, type Sink } from './mouse.js';

export type InputMode = 'filter' | 'tap';

export interface Input {
  /** stream que o Ink deve ler */
  stdin: NodeJS.ReadStream;
  /** eventos 'mouse' (MouseEv) e 'fkey' (FKey) */
  bus: EventEmitter;
  dispose(): void;
}

/** tempo que um ESC (ou ESC [ / ESC O) espera o resto da sequência antes de ir ao Ink como tecla */
const HOLD_KEY_MS = 25;
/** tempo que um ESC [ < ... espera; só pode ser mouse, então espera mais antes de desistir */
const HOLD_MOUSE_MS = 250;

export function createInput(mode: InputMode, real: NodeJS.ReadStream): Input {
  const bus = new EventEmitter();
  const sink: Sink = { mouse: (e: MouseEv) => bus.emit('mouse', e), fkey: (k: FKey) => bus.emit('fkey', k) };

  if (mode === 'tap') {
    const off = tapStdin(real, sink);
    return { stdin: real, bus, dispose: off };
  }

  const out = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(out, {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) { real.setRawMode(on); (out as { isRaw: boolean }).isRaw = on; return out; },
    ref() { real.ref(); return out; },
    unref() { real.unref(); return out; },
  });
  real.setEncoding('utf8');

  let carry = '';
  let timer: NodeJS.Timeout | undefined;
  const flushCarry = () => { timer = undefined; if (carry) { const c = carry; carry = ''; out.write(c); } };
  const onData = (chunk: string | Buffer) => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const r = scan(carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8')), sink);
    carry = r.tail;
    if (r.rest) out.write(r.rest);
    if (carry) timer = setTimeout(flushCarry, carry.startsWith('\x1b[<') ? HOLD_MOUSE_MS : HOLD_KEY_MS);
  };
  real.on('data', onData);
  return {
    stdin: out,
    bus,
    dispose() { real.off('data', onData); if (timer) clearTimeout(timer); out.destroy(); },
  };
}
