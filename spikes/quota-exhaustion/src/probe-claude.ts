// Sonda: sobe o claude-agent-acp contra o mock Anthropic e manda 1 prompt (sem erro), para ver que requisições o cliente faz.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Adapter, FAKE_KEY, OUT, PORTS, PROFILES, WT, cleanEnv, configOptionValues, ensureRepo, result, scrubObj } from './lib.ts';
import { startMock } from './mock.ts';
import { HERE } from './lib.ts';

ensureRepo();
const mock = await startMock('anthropic', PORTS.claude, join(OUT, 'probe-claude.mock.jsonl'));
const cfg = join(PROFILES, 'claude-probe');
mkdirSync(cfg, { recursive: true });
const a = Adapter.start({
  name: 'probe-claude',
  cmd: process.execPath,
  args: [join(HERE, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')],
  env: cleanEnv({ CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.claude}`, ANTHROPIC_API_KEY: FAKE_KEY }),
});
const init = await a.initialize();
const s = await a.newSession(WT(1));
console.log('config', JSON.stringify(scrubObj((s as any).configOptions?.map((o: any) => ({ id: o.id, cur: o.currentValue }))), null, 0));
console.log('models', configOptionValues(s, 'model'));
await a.setOption(s.sessionId, 'model', 'haiku').catch((e) => console.log('model err', e.message));
await a.setOption(s.sessionId, 'effort', 'low').catch((e) => console.log('effort err', e.message));
const r = await a.prompt(s.sessionId, 'Diga oi em uma frase.', 'probe', 60000);
result('probe.jsonl', 'probe-claude', { authMethods: (init as any).authMethods, r: { ...r, usageUpdates: r.usageUpdates.slice(-2) }, mock: mock.log });
await a.stop();
await mock.stop();
process.exit(0);
