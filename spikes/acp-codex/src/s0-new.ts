// Itens 1 e 2 (sem prompt): initialize + session/new com mcpServers HTTP; registra capabilities, authMethods, config options, modos, modelos.
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, result, summarizeTree, sleep } from './lib.ts';
import { startMcp } from './mcp-server.ts';

const mcp = await startMcp();
const a = Adapter.start({ name: 's0-new' });
const t0 = Date.now();
const init = await a.initialize();
result('initialize', { ms: Date.now() - t0, init });
const t1 = Date.now();
const s = await a.agent.request(acp.methods.agent.session.new, {
  cwd: WT(1),
  mcpServers: [{ type: 'http', name: 'spike', url: mcp.url, headers: [] }],
});
result('session/new', { ms: Date.now() - t1, s });
await sleep(3000);
result('mcp-requests-after-new', { requests: mcp.requests, calls: mcp.calls });
result('tree-after-new', summarizeTree(a.pid));
result('updates-after-new', a.updates.map((u) => u.update));
await a.stop();
await mcp.close();
process.exit(0);
