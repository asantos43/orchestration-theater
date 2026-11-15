// Itens 2 e 3 (e 8 parcial): prompt trivial que usa o MCP HTTP; mede streaming; /status para cota; caminho dos arquivos de sessão.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, OUT, result, summarizeTree, updateKinds, textOf, countPrompt, sleep, fileSize } from './lib.ts';
import { startMcp } from './mcp-server.ts';
import { join } from 'node:path';

const mcp = await startMcp();
const a = Adapter.start({ name: process.argv[2] ?? 's1-stream' })
a.permission = (process.argv[3] ?? 'reject') as 'allow' | 'reject';
await a.initialize();
const s = await a.agent.request(acp.methods.agent.session.new, {
  cwd: WT(1),
  mcpServers: [{ type: 'http', name: 'spike', url: mcp.url, headers: [] }],
});
const sid = s.sessionId;
const setOpt = async (configId: string, value: string) => {
  const r = await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: sid, configId, value });
  return r;
};
const r1 = await setOpt('model', 'gpt-6-luna');
const r2 = await setOpt('reasoning_effort', 'low');
const r3 = await setOpt('mode', 'workspace-write');
result('set_config_option', {
  afterAll: (r3 as { configOptions?: { id: string; currentValue: string }[] }).configOptions?.map((o) => `${o.id}=${o.currentValue}`),
  rawKeys: Object.keys(r1),
});

a.updates.length = 0;
const t0 = Date.now();
let tFirst = 0, tFirstText = 0, tFirstTool = 0;
a.onUpdate = (u) => {
  tFirst ||= u.at;
  const k = (u.update as { sessionUpdate: string }).sessionUpdate;
  if (!tFirstText && k === 'agent_message_chunk') tFirstText = u.at;
  if (!tFirstTool && k === 'tool_call') tFirstTool = u.at;
};
countPrompt('s1b-ping-submit-allow');
const resp = await a.agent.request(acp.methods.agent.session.prompt, {
  sessionId: sid,
  prompt: [{ type: 'text', text: "Use the MCP tool 'ping' from the server 'spike', then call the MCP tool 'submit_result' with summary 'ok'. Do nothing else and keep the final answer to one short sentence." }],
});
const tEnd = Date.now();
const tl = a.updates.map((u) => ({ dt: u.at - t0, kind: (u.update as { sessionUpdate: string }).sessionUpdate, text: textOf(u.update).slice(0, 80) }));
result('prompt-1', {
  stopReason: resp.stopReason,
  response: resp,
  meta: resp._meta,
  totalMs: tEnd - t0,
  firstUpdateMs: tFirst - t0,
  firstAgentTextMs: tFirstText ? tFirstText - t0 : null,
  firstToolCallMs: tFirstTool ? tFirstTool - t0 : null,
  kinds: updateKinds(a.updates),
  timelineHead: tl.slice(0, 40),
  mcpCalls: mcp.calls,
});
const toolCalls = a.updates.filter((u) => ['tool_call', 'tool_call_update'].includes((u.update as { sessionUpdate: string }).sessionUpdate)).map((u) => u.update);
result('tool-call-updates', toolCalls.slice(0, 8));

// /status: tratado localmente pelo adaptador, sem turno do modelo; atualiza account/rateLimits/read
a.updates.length = 0;
countPrompt('s1b-status', false);
const st = await a.agent.request(acp.methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: 'text', text: '/status' }] });
result('status-command', { stopReason: st.stopReason, meta: st._meta, text: a.updates.map((u) => textOf(u.update)).join('').replace(/\([^)]*@[^)]*\)/, '(email)') });

// arquivos de sessão: só caminho e tamanho
let files = '';
try {
  files = execSync(`find ${homedir()}/.codex -newer ${OUT}/s0-new.jsonl \\( -path '*sessions*' -o -name '*.sqlite*' -o -name session_index.jsonl \\) -type f 2>/dev/null | head -20`).toString();
} catch {}
const byId = execSync(`find ${homedir()}/.codex/sessions -name '*${sid}*' -type f 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
result('session-files', { sid, byId: byId.map((p) => ({ p, bytes: fileSize(p) })), recentlyModified: files.trim().split('\n').filter(Boolean).map((p) => ({ p, bytes: fileSize(p) })) });
result('tree', summarizeTree(a.pid));
writeFileSync(join(OUT, 'state-s1b.json'), JSON.stringify({ sid, cwd: WT(1) }));
await sleep(500);
await a.stop();
await mcp.close();
process.exit(0);
