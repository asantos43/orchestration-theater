// Item 1: velocidade do llama-server (prompt, geração, tempo até o primeiro token) e RAM.
// Uso: node src/bench.ts <rotulo> <pid-do-llama-server> [tokens-de-entrada=14000] [reps=3]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLAMA_PORT, OUT } from './lib/paths.ts';

const [label, pidStr, nTok = '14000', nReps = '3'] = process.argv.slice(2);
const pid = Number(pidStr);
const base = `http://127.0.0.1:${LLAMA_PORT}`;
const rss = () => Math.round(Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4 / 1024);
const gpu = () => {
  const r: Record<string, number> = {};
  for (const k of ['mem_info_vram_used', 'mem_info_gtt_used']) {
    for (const c of ['card0', 'card1']) {
      try { r[`${k}_${c}`] = Math.round(Number(readFileSync(`/sys/class/drm/${c}/device/${k}`, 'utf8')) / 1048576); } catch {}
    }
  }
  return r;
};
const tokCount = async (text: string) => ((await (await fetch(`${base}/tokenize`, { method: 'POST', body: JSON.stringify({ content: text }) })).json()) as any).tokens.length as number;

// texto de enchimento: a própria arquitetura, cortada até ~nTok tokens
const doc = readFileSync(new URL('../../../docs/framework-ideas/arquitetura.md', import.meta.url), 'utf8');
let lo = 1000, hi = doc.length;
while (hi - lo > 2000) { const mid = (lo + hi) >> 1; if ((await tokCount(doc.slice(0, mid))) > Number(nTok)) hi = mid; else lo = mid; }
const filler = doc.slice(0, lo);
const inTokens = await tokCount(filler);

const ram0 = rss();
const out: any = { label, pid, inputTokensApprox: inTokens, ramBeforeMb: ram0, gpuBefore: gpu(), runs: [] as any[] };
for (let i = 0; i < Number(nReps); i++) {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'x', stream: true, stream_options: { include_usage: true }, cache_prompt: false, max_tokens: 160, temperature: 0,
      messages: [{ role: 'user', content: `${filler}\n\n---\nWrite a long, detailed summary of the text above in about 120 words.` }],
    }),
  });
  let first: number | null = null, firstReason: number | null = null, timings: any = null, usage: any = null, text = '';
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const j = JSON.parse(line.slice(5));
      const d = j.choices?.[0]?.delta;
      if (d?.reasoning_content && firstReason === null) firstReason = performance.now() - t0;
      if (d?.content) { if (first === null) first = performance.now() - t0; text += d.content; }
      if (j.timings) timings = j.timings;
      if (j.usage) usage = j.usage;
    }
  }
  out.runs.push({
    ttftMs: first && Math.round(first), firstReasoningMs: firstReason && Math.round(firstReason), totalMs: Math.round(performance.now() - t0),
    promptTokens: timings?.prompt_n ?? usage?.prompt_tokens, promptTokPerS: timings && Math.round(timings.prompt_per_second * 10) / 10,
    genTokens: timings?.predicted_n, genTokPerS: timings && Math.round(timings.predicted_per_second * 10) / 10, ramAfterMb: rss(), gpuAfter: gpu(), sample: text.slice(0, 120),
  });
  console.log(JSON.stringify(out.runs.at(-1)));
}
writeFileSync(join(OUT, `bench-${label}.json`), JSON.stringify(out, null, 1));
