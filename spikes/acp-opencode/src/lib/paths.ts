import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(ROOT, 'out');
export const SCRATCH =
  '/tmp/claude-1000/-home-anderson--claude-spares-spare-stJI7q/7fae85d3-3bfb-4d0b-aaf1-48870b56d0b2/scratchpad/acp-opencode';
export const REPO = join(SCRATCH, 'repo');
export const WT = [1, 2, 3].map((i) => join(SCRATCH, `wt${i}`));
/**
 * Modelo usado. O gateway opencode/* deu "API key expired" (1 prompt perdido) e o Gemma 4 (cost 0) estourou a cota gratuita
 * do Google (limite de 16000 tokens de entrada por minuto; o OpenCode manda ~13-15k tokens por requisição). Padrão: o mais barato
 * pago com ferramentas da conta Google (cost.input 0.25 USD/M).
 */
export const MODEL = process.env.OT_MODEL ?? 'google/gemini-3.1-flash-lite';

mkdirSync(OUT, { recursive: true });
