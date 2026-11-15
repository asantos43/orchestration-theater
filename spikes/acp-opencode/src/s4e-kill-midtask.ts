// Item 6 (repetição): kill -9 de verdade no meio da tarefa (o s4c matou 2 s depois do 1º chunk e a tarefa já tinha acabado)
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';
import { tree } from './lib/proc.ts';

const cwd = WT[1];
const out: Record<string, any> = {};
let crashId: string;
{
  const ag = await startAgent({ name: 's4e-kill-midtask', cwd });
  await initialize(ag);
  const s = await newSession(ag, cwd);
  crashId = s.sessionId;
  await pickCheap(ag, crashId);
  let chunks = 0;
  let chars = 0;
  let killed = false;
  let before: any[] = [];
  let promptEnded = false;
  ag.listeners.add((n) => {
    const u = n.update as any;
    if (u.sessionUpdate === 'agent_message_chunk') {
      chunks++;
      chars += u.content?.text?.length ?? 0;
      if (chunks === 2 && !killed) {
        killed = true;
        before = tree(ag.pid);
        process.kill(ag.pid, 'SIGKILL');
        out.killedAtMs = Math.round(ag.wire.now());
        out.promptEndedBeforeKill = promptEnded;
      }
    }
  });
  const p = ag.prompt(crashId, 'Write the numbers 1 to 600, one per line, each followed by a different short English word. Do not use tools.', 's4e-task-to-kill')
    .then((r) => { promptEnded = true; return { stopReason: r.stopReason, error: (r.response as any).error ? String((r.response as any).error?.message ?? (r.response as any).error) : null }; })
    .catch((e) => ({ rejected: String(e?.message ?? e) }));
  const res = await Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: 20000 }), 20000))]);
  out.crash = { sessionId: crashId, chunksBeforeKill: chunks, charsBeforeKill: chars, promptResult: res, exit: ag.exit, tree: before.map((x) => ({ pid: x.pid, comm: x.comm })) };
  await new Promise((r) => setTimeout(r, 1500));
  out.survivors = before.filter((x) => existsSync(`/proc/${x.pid}`)).map((x) => ({ pid: x.pid, comm: x.comm }));
  for (const x of before) { try { process.kill(x.pid, 'SIGKILL'); } catch {} }
  await ag.close();
}
{
  const ag = await startAgent({ name: 's4e-load-after-kill', cwd });
  await initialize(ag);
  const counts: Record<string, number> = {};
  let text = '';
  ag.listeners.add((n) => { const u = n.update as any; counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1; if (u.content?.text) text += u.content.text; });
  try {
    await ag.a.request(acp.methods.agent.session.load, { sessionId: crashId, cwd, mcpServers: [] });
    await new Promise((r) => setTimeout(r, 500));
    const nums = [...text.matchAll(/^(\d+) /gm)].map((m) => Number(m[1]));
    out.loadAfterKill = { ok: true, counts: { ...counts }, replayChars: text.length, lastNumber: nums.at(-1) ?? null, tail: text.slice(-60) };
  } catch (e: any) { out.loadAfterKill = { ok: false, error: String(e?.message ?? e) }; }
  await ag.close();
}
writeFileSync(join(OUT, 's4e.result.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
