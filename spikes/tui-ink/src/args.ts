export interface Args {
  scenario: 'stream' | 'history';
  rate: number;
  duration: number;
  messages: number;
  steps: number;
  seed: number;
  /** modo de renderização do Ink */
  incremental: boolean;
  maxFps: number;
  /** "own" = linha de entrada própria; "ui" = TextInput do @inkjs/ui */
  input: 'own' | 'ui';
  alt: boolean;
  /** quando a notificação do Store chega ao React: ms (padrão 16), 0 = a cada evento, sem timer */
  coalesce: number;
  /** "throttle" = a tecla espera o throttle de quadros do Ink (padrão); "flush" = força o quadro logo após a tecla */
  keyRender: 'throttle' | 'flush';
  /** isola o estado (memo em LineView/InputLine; App não assina o Store) */
  memo: boolean;
  /** mensagens mantidas em memória (0 = todas) */
  historyWindow: number;
  /** arquivo JSONL de diagnóstico (marcas de tempo, memória); vazio = desligado */
  trace: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { scenario: 'stream', rate: 20, duration: 300, messages: 5000, steps: 1000, seed: 42, incremental: false, maxFps: 30, input: 'own', alt: true, coalesce: 16, keyRender: 'throttle', memo: false, historyWindow: 0, trace: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--scenario': a.scenario = v === 'history' ? 'history' : 'stream'; i++; break;
      case '--rate': a.rate = Number(v); i++; break;
      case '--duration': a.duration = Number(v); i++; break;
      case '--messages': a.messages = Number(v); i++; break;
      case '--steps': a.steps = Number(v); i++; break;
      case '--seed': a.seed = Number(v); i++; break;
      case '--max-fps': a.maxFps = Number(v); i++; break;
      case '--input': a.input = v === 'ui' ? 'ui' : 'own'; i++; break;
      case '--incremental': a.incremental = true; break;
      case '--coalesce': a.coalesce = Math.max(0, Number(v)); i++; break;
      case '--key-render': a.keyRender = v === 'flush' ? 'flush' : 'throttle'; i++; break;
      case '--memo': a.memo = true; break;
      case '--history-window': a.historyWindow = Math.max(0, Number(v)); i++; break;
      case '--trace': a.trace = String(v); i++; break;
      case '--no-alt': a.alt = false; break;
    }
  }
  return a;
}
