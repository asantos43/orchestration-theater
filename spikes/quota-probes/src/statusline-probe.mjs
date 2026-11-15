// Comando de statusline do Claude Code: le o JSON do stdin e o grava em out/statusline/.
// Uma linha por chamada em calls.jsonl (instante, tamanho, chaves) e o JSON cru em raw/<n>.json.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.QP_STATUS_DIR ?? join(import.meta.dirname, '..', 'out', 'statusline');
mkdirSync(join(OUT, 'raw'), { recursive: true });
const t = Date.now();
let input = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) input += c;
let parsed = null;
try {
  parsed = JSON.parse(input);
} catch {}
const stamp = `${t}-${process.pid}`;
writeFileSync(join(OUT, 'raw', `${stamp}.json`), input);
writeFileSync(join(OUT, 'last.json'), input);
appendFileSync(
  join(OUT, 'calls.jsonl'),
  JSON.stringify({
    ms: t,
    iso: new Date(t).toISOString(),
    pid: process.pid,
    bytes: input.length,
    keys: parsed ? Object.keys(parsed) : null,
    rate_limits: parsed?.rate_limits ?? null,
  }) + '\n',
);
const rl = parsed?.rate_limits;
const fmt = (w) => (w ? `${w.used_percentage}%` : '-');
process.stdout.write(`probe 5h:${fmt(rl?.five_hour)} 7d:${fmt(rl?.seven_day)}`);
