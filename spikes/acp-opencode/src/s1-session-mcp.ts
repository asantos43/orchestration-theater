// Itens 1, 2 e 3: initialize, session/new com worktree + MCP HTTP, streaming (1 prompt)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent } from './lib/agent.ts';
import { startMcp } from './lib/mcp-server.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';
import { summarize, tree } from './lib/proc.ts';

const mcp = await startMcp(join(OUT, 's1-mcp.jsonl'));
const ag = await startAgent({ name: 's1', cwd: WT[0] });
const t0 = performance.now();
const init = await initialize(ag);
const initMs = Math.round(performance.now() - t0);
const t1 = performance.now();
const s = await newSession(ag, WT[0], mcp.url);
const newMs = Math.round(performance.now() - t1);
const optsDefault = s.configOptions;
const cheap = await pickCheap(ag, s.sessionId);
const idle = summarize(tree(ag.pid));
const r = await ag.prompt(
  s.sessionId,
  'Use the MCP tool "ping" once, then call the MCP tool "submit_result" with summary "ping ok". Do not use any other tool. Reply with one short word.',
  's1-ping-submit',
);
const after = summarize(tree(ag.pid));
const res = {
  versionAgent: (init as any).agentInfo,
  authMethods: init.authMethods,
  agentCapabilities: init.agentCapabilities,
  initMs, newMs,
  sessionNewKeys: Object.keys(s),
  configOptionsDefault: (optsDefault as any[]).map((o) => ({ id: o.id, category: o.category, type: o.type, current: o.currentValue, nOptions: o.options?.length })),
  modes: (cheap.final as any[]).find((o) => o.id === 'mode')?.options,
  effortValuesForCheapModel: cheap.effortValues,
  prompt: { ...r, response: r.response },
  mcpCalls: mcp.calls,
  procIdle: idle, procAfterPrompt: after,
};
writeFileSync(join(OUT, 's1.result.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, configOptionsDefault: res.configOptionsDefault, procIdle: { count: idle.count, rssMb: idle.rssMb, pssMb: idle.pssMb }, procAfterPrompt: { count: after.count, rssMb: after.rssMb, pssMb: after.pssMb } }, null, 1));
await ag.close();
await mcp.close();
