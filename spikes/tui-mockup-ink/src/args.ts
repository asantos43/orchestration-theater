import type { InputMode } from './input.js';
import type { MouseMode } from './mouse.js';
import type { ScreenId } from './state.js';

export interface Args { mouse: MouseMode; screen: ScreenId; input: InputMode; help: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = { mouse: 'full', screen: 'main', input: 'filter', help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--mouse') { a.mouse = v === 'wheel' || v === 'off' ? v : 'full'; i++; }
    else if (k === '--screen') { a.screen = v === 'traj' || v === 'config' || v === 'focus' ? v : 'main'; i++; }
    else if (k === '--input') { a.input = v === 'tap' ? 'tap' : 'filter'; i++; }
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

export const HELP = `uso: npm start -- [--mouse full|wheel|off] [--screen main|traj|config|focus]
  --mouse   full (padrão): roda, clique e arrasto; wheel: só a roda; off: sem rastreamento
  --screen  tela inicial (F2 main, F3 traj, F4 config, F5 focus)
  --input   filter (padrão): o app tira o mouse e as teclas F do stdin antes do Ink; tap: o Ink lê tudo e o app só espia
  Ctrl+Q sai. Terminal recomendado: 140x42 ou maior.`;
