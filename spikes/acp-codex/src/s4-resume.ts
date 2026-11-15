// Item 6: session/load em processo novo (tarefa terminada) e depois de kill -9 no meio de uma tarefa.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, OUT, result, newSession, runPrompt, countPrompt, updateKinds, textOf, codexSessionFiles, allProcs, sleep, now } from './lib.ts';

const loadSession = async (a: Adapter, sid: string, cwd: string) => {
  a.updates.length = 0;
  const t0 = now();
  let res: unknown, err: unknown;
  try {
    res = await a.agent.request(acp.methods.agent.session.load, { sessionId: sid, cwd, mcpServers: [] });
  } catch (e) {
    err = e;
  }
  const ms = now() - t0;
  const rep = a.updates.map((u) => u.update as unknown as { sessionUpdate: string });
  return {
    ms,
    error: err ? String((err as Error).message ?? err) + ' ' + JSON.stringify((err as { data?: unknown }).data ?? '') : null,
    replayKinds: updateKinds(a.updates),
    replayedUserText: a.updates.filter((u) => (u.update as { sessionUpdate: string }).sessionUpdate === 'user_message_chunk').map((u) => textOf(u.update)).join('').slice(0, 300),
    replayedAgentText: a.updates.filter((u) => (u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk').map((u) => textOf(u.update)).join('').slice(0, 300),
    resultKeys: res ? Object.keys(res as object) : null,
    currentConfig: (res as { configOptions?: { id: string; currentValue: string }[] } | undefined)?.configOptions?.map((o) => `${o.id}=${o.currentValue}`),
    totalUpdates: rep.length,
  };
};

// ---- Parte A: tarefa terminada (sessão da s1b) -> processo NOVO -> session/load
const prev = JSON.parse(readFileSync(join(OUT, 'state-s1b.json'), 'utf8')) as { sid: string; cwd: string };
const a1 = Adapter.start({ name: 's4a-load-finished' });
await a1.initialize();
const A = await loadSession(a1, prev.sid, prev.cwd);
result('A session/load de tarefa terminada (processo novo)', { sid: prev.sid, ...A, files: codexSessionFiles(prev.sid) });
countPrompt('s4a-follow-up');
const fu = await runPrompt(a1, prev.sid, 'Without calling any tool: which MCP tools did you call earlier in this conversation? Answer in one short sentence.', 's4a-follow-up');
result('A follow-up pós-load (o modelo lembra?)', { stopReason: fu.stopReason, agentText: fu.agentText, ms: fu.ms });
await a1.stop();

// ---- Parte B: kill -9 no meio de uma tarefa
const a2 = Adapter.start({ name: 's4b-kill9' });
a2.permission = 'allow';
await a2.initialize();
const s2 = await newSession(a2, WT(2));
const sid2 = s2.sessionId;
const adapterPid = a2.pid;
let killedAt = 0;
let first = 0;
a2.onUpdate = (u) => {
  if (!first && (u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk') {
    first = u.at;
    setTimeout(() => {
      killedAt = now();
      process.kill(adapterPid, 'SIGKILL');
    }, 1500);
  }
};
countPrompt('s4b-kill-task');
const pr = a2.agent.request(acp.methods.agent.session.prompt, { sessionId: sid2, prompt: [{ type: 'text', text: 'Write a 300-word story about a lighthouse keeper. No tools.' }] }).then(
  (r) => ({ ok: true as const, r }),
  (e) => ({ ok: false as const, e: String((e as Error).message ?? e) }),
);
const outcome = await Promise.race([pr, sleep(30000).then(() => ({ ok: false as const, e: 'timeout 30s' }))]);
await sleep(1500);
const survivors = allProcs().filter((p) => p.cmd.includes('spikes/acp-codex/node_modules'));
result('B kill -9 do adaptador no meio da tarefa', {
  killedAfterMs: killedAt - first,
  promptOutcome: outcome,
  adapterExit: a2.exited,
  survivors: survivors.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, rssMB: Math.round(p.rssKB / 1024), cmd: p.cmd.slice(-90) })),
  filesBeforeLoad: codexSessionFiles(sid2),
});
// limpa sobreviventes (órfãos do app-server) antes de seguir
for (const p of survivors) {
  try {
    process.kill(p.pid, 'SIGKILL');
  } catch {}
}
await sleep(500);

const a3 = Adapter.start({ name: 's4c-load-after-kill' });
await a3.initialize();
const B = await loadSession(a3, sid2, WT(2));
result('B session/load depois do kill -9 (processo novo)', { sid: sid2, ...B });
const fu2 = await runPrompt(a3, sid2, 'Without calling any tool: what were you writing before the interruption, and did you finish? Answer in one short sentence.', 's4c-follow-up');
result('B follow-up depois do load', { stopReason: fu2.stopReason, agentText: fu2.agentText, ms: fu2.ms });
await a3.stop();
process.exit(0);
