import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './paths.ts';

const COUNTER = join(OUT, 'prompt-count.json');
const PROMPTS = join(OUT, 'prompts.jsonl');
export const MAX_PROMPTS = 25;

/** Contador global (entre processos) do limite de 25 prompts. Lança ao estourar. */
export function spendPrompt(label: string, text: string): number {
  const n = existsSync(COUNTER) ? (JSON.parse(readFileSync(COUNTER, 'utf8')).n as number) : 0;
  if (n >= MAX_PROMPTS) throw new Error(`limite de ${MAX_PROMPTS} prompts atingido`);
  writeFileSync(COUNTER, JSON.stringify({ n: n + 1 }));
  appendFileSync(
    PROMPTS,
    JSON.stringify({ n: n + 1, at: new Date().toISOString(), label, text }) + '\n',
  );
  return n + 1;
}
export function promptsSpent(): number {
  return existsSync(COUNTER) ? (JSON.parse(readFileSync(COUNTER, 'utf8')).n as number) : 0;
}
