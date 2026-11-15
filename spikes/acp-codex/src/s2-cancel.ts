// Item 4: session/cancel no meio de um prompt.
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, result, newSession, countPrompt, updateKinds, now, sleep, textOf } from './lib.ts';

const a = Adapter.start({ name: 's2-cancel' });
a.permission = 'allow';
await a.initialize();
const s = await newSession(a, WT(2));
const sid = s.sessionId;
a.updates.length = 0;
countPrompt('s2-cancel-long');
const t0 = now();
let firstChunk = 0;
let cancelAt = 0;
a.onUpdate = (u) => {
  if (!firstChunk && (u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk') {
    firstChunk = u.at;
    setTimeout(() => {
      cancelAt = now();
      void a.agent.notify(acp.methods.agent.session.cancel, { sessionId: sid });
    }, 1500);
  }
};
const p = a.agent.request(acp.methods.agent.session.prompt, {
  sessionId: sid,
  prompt: [{ type: 'text', text: 'Write the integers from 1 to 400, one per line, with no other text.' }],
});
const resp = await p;
const tEnd = now();
const lastChunkAt = Math.max(...a.updates.filter((u) => (u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk').map((u) => u.at));
const chunks = a.updates.filter((u) => (u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk');
result('cancel', {
  stopReason: resp.stopReason,
  response: resp,
  firstChunkMs: firstChunk - t0,
  cancelSentMs: cancelAt - t0,
  cancelToResponseMs: tEnd - cancelAt,
  lastChunkAfterCancelMs: lastChunkAt - cancelAt,
  chunksTotal: chunks.length,
  chunksAfterCancel: chunks.filter((c) => c.at > cancelAt).length,
  textSoFarChars: chunks.map((c) => textOf(c.update)).join('').length,
  kinds: updateKinds(a.updates),
});
// a sessão continua utilizável? (/status não gasta modelo)
countPrompt('s2-status-after-cancel', false);
const st = await a.agent.request(acp.methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: 'text', text: '/status' }] });
result('after-cancel-session-alive', { stopReason: st.stopReason });
await sleep(300);
await a.stop();
process.exit(0);
