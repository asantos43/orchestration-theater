// Gancho de módulos do Node (module.registerHooks, síncrono): troca arquivos do Ink 8.0.0 pelos de patches/ink/.
// Só é carregado pelo launcher quando a linha de comando traz `--ink-patch LISTA` (LISTA: cache,... ou all).
// O resto do Ink (e o @inkjs/ui, que importa 'ink') continua sendo o original: a URL do módulo não muda,
// só o texto que o Node carrega para ele.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('./ink/', import.meta.url);
const PATCHED = ['output.js'];

registerHooks({
  load(url, context, nextLoad) {
    const m = /\/node_modules\/ink\/build\/(.+)$/.exec(url);
    if (m && PATCHED.includes(m[1])) {
      const file = new URL(m[1], dir);
      try {
        return { format: 'module', source: readFileSync(fileURLToPath(file), 'utf8'), shortCircuit: true };
      } catch {
        /* arquivo de patch ausente: segue com o original */
      }
    }
    return nextLoad(url, context);
  },
});
