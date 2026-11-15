// Ponto de entrada de `dist/main.js`. Só decide o que carregar ANTES do app:
//  - `--trace`: gancho do WASM do Yoga (diagnóstico de memória);
//  - `--ink-patch LISTA`: registra o gancho que troca módulos do Ink pelos de `patches/ink/` (ver patches/README).
// Sem essas flags o app roda com o Ink original, exatamente como antes.
import './wasm-hook.js';

const argv = process.argv;
const i = argv.indexOf('--ink-patch');
if (i >= 0) {
  const list = String(argv[i + 1] ?? 'all');
  (globalThis as { __otInkPatch?: string }).__otInkPatch = list;
  await import(new URL('../patches/register.mjs', import.meta.url).href);
}
await import(new URL('./app.js', import.meta.url).href);
