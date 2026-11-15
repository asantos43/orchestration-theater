// Extrai do log do llama-server uma linha por requisição: tokens processados no prompt, tokens/s do prompt, tokens gerados, tokens/s de geração.
// Uso: node src/parse-llama-log.ts out/llama-server.log > out/llama-requests.json
import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2] ?? 'out/llama-server.log', 'utf8').split('\n');
const reqs: any[] = [];
let cur: any = null;
for (const l of log) {
  let m;
  if ((m = /launch_slot_: id +\d+ \| task (\d+)/.exec(l))) cur = { task: Number(m[1]) };
  else if (cur && (m = /prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens.*?([\d.]+) tokens per second/.exec(l))) Object.assign(cur, { promptMs: Number(m[1]), promptTokensProcessed: Number(m[2]), promptTps: Number(m[3]) });
  else if (cur && (m = /\|\s+eval time =\s+([\d.]+) ms \/\s+(\d+) tokens.*?([\d.]+) tokens per second/.exec(l))) Object.assign(cur, { genMs: Number(m[1]), genTokens: Number(m[2]), genTps: Number(m[3]) });
  else if (cur && (m = /stop processing: n_tokens = (\d+)/.exec(l))) { cur.contextTokensAtEnd = Number(m[1]); reqs.push(cur); cur = null; }
  else if (cur && (m = /selected slot by (\w+ ?\w*)/.exec(l))) cur.slotSelection = m[0];
}
console.log(JSON.stringify(reqs, null, 1));
