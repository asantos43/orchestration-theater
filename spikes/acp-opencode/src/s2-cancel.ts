// Itens 3 (granularidade do streaming) e 4 (cancelamento): 1 prompt longo, session/cancel no meio
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';

const ag = await startAgent({ name: 's2', cwd: WT[0] });
await initialize(ag);
const s = await newSession(ag, WT[0]);
await pickCheap(ag, s.sessionId);

const chunks: { t: number; kind: string; len: number }[] = [];
const t0 = performance.now();
let cancelAt: number | null = null;
let cancelSent: Promise<void> | null = null;
const sendCancel = () => {
  if (cancelAt !== null) return;
  cancelAt = performance.now();
  cancelSent = ag.a.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId });
};
ag.listeners.add((n) => {
  const u = n.update as any;
  chunks.push({ t: Math.round(performance.now() - t0), kind: u.sessionUpdate, len: u.content?.text?.length ?? 0 });
  // cancela 3 s depois do primeiro pedaço de texto
  if (u.sessionUpdate === 'agent_message_chunk' && cancelAt === null) setTimeout(sendCancel, 3000);
});
// rede de segurança: cancela aos 150 s mesmo sem texto
const safety = setTimeout(sendCancel, 150_000);
const r = await ag.prompt(
  s.sessionId,
  'Count from 1 to 80. Put each number on its own line followed by a short English word. Do not use any tools. Do not stop early.',
  's2-cancel',
);
clearTimeout(safety);
await cancelSent;
const res = {
  stopReason: r.stopReason,
  promptMs: r.ms,
  firstUpdateMs: r.firstUpdateMs,
  firstTextChunkMs: r.firstTextChunkMs,
  cancelSentAtMs: cancelAt === null ? null : Math.round(cancelAt - t0),
  cancelLatencyMs: cancelAt === null ? null : Math.round(t0 + r.ms - cancelAt),
  updateCounts: r.updateCounts,
  nTextChunks: chunks.filter((c) => c.kind === 'agent_message_chunk').length,
  chunkTimeline: chunks.slice(0, 40),
  textCharsReceived: r.text.length,
  textHead: r.text.slice(0, 80),
  usage: r.usage,
  response: r.response,
};
writeFileSync(join(OUT, 's2.result.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
await ag.close();
