// Tempo até o P1 terminar e número de requisições principais, por cenário e repetição.
// Uso: node src/times.ts <cliente>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.ts';

const client = process.argv[2];
if (!client) throw new Error('uso: node src/times.ts <claude|codex|opencode>');
const rows = readFileSync(join(OUT, `${client}-results.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const groups = new Map<string, { ms: number; main: number; stop: string }[]>();
for (const r of rows) {
  const d = r.data;
  const key = `${d.scenario}${d.typedFailures ? ' (typed)' : ''}`;
  const p1 = d.p1;
  const arr = groups.get(key) ?? [];
  arr.push({ ms: p1.ms, main: d.p1MockMain?.length ?? -1, stop: p1.stopReason ?? (p1.error ? `erro ${p1.error.code}` : '-') });
  groups.set(key, arr);
}
for (const [k, v] of groups) {
  console.log(`${k.padEnd(48)} n=${v.length}  ms=${v.map((x) => x.ms).join('/')}  reqs=${v.map((x) => x.main).join('/')}  stop=${[...new Set(v.map((x) => x.stop))].join(',')}`);
}
