// Instrumentação de diagnóstico (só com --trace ARQUIVO). Não muda o comportamento do app.
// Grava JSONL ao sair: marcas de tempo de teclas, renders, escritas no pty e amostras de memória.
import { writeFileSync } from 'node:fs';
import { wasmMemories } from './wasm-hook.js';

type Ev = Record<string, number | string>;
const evs: Ev[] = [];
let on = false;
const T0 = performance.now();
export const tnow = (): number => performance.now() - T0;

export function trace(ev: Ev): void {
  if (on) evs.push({ ...ev, t: Math.round(tnow() * 100) / 100 });
}
export const tracing = (): boolean => on;

export function startTrace(file: string): void {
  on = true;
  const out = process.stdout;
  const orig = out.write.bind(out) as (...a: unknown[]) => boolean;
  (out as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    const t = tnow();
    const r = orig(chunk, ...rest);
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    // `Z` é o caractere que a bancada digita; `dur` = tempo gasto na chamada write()
    evs.push({ k: 'w', t: Math.round(t * 100) / 100, dur: Math.round((tnow() - t) * 100) / 100, b: Buffer.byteLength(s), z: s.includes('Z') ? 1 : 0 });
    return r;
  };
  // leitura do stdin: instante em que o Node entrega o dado ao Ink
  process.stdin.prependListener('readable', () => trace({ k: 'in' }));
  const mem = (): void => {
    const m = process.memoryUsage();
    const wasm = wasmMemories.reduce((a, w) => a + w.buffer.byteLength, 0);
    trace({ k: 'mem', rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, wasm });
  };
  mem();
  const h = setInterval(mem, 1000);
  h.unref();
  process.on('exit', () => {
    mem();
    writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
}
