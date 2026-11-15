// Sonda: opencode acp contra o mock OpenAI-compatible (chat completions), 1 prompt sem erro.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Adapter, OUT, PORTS, PROFILES, WT, configOptionValues, ensureRepo, result, scrubObj } from './lib.ts';
import { startMock } from './mock.ts';
import { opencode } from './clients.ts';

ensureRepo();
rmSync(join(PROFILES, 'opencode-quota'), { recursive: true, force: true });
const mock = await startMock('chat', PORTS.opencode, join(OUT, 'probe-opencode.mock.jsonl'));
const a = Adapter.start(opencode.spec('probe-opencode'));
const init: any = await a.initialize();
console.log('auth', JSON.stringify(init.authMethods?.map((m: any) => m.id)));
let s: any;
try {
  s = await a.newSession(WT(3));
} catch (e: any) {
  console.log('session/new falhou', e.code, e.message, JSON.stringify(e.data));
  await a.stop(); await mock.stop(); process.exit(1);
}
console.log('config', JSON.stringify(s.configOptions?.map((o: any) => ({ id: o.id, cur: o.currentValue }))));
console.log('modes', configOptionValues(s, 'mode'), 'models', JSON.stringify(configOptionValues(s, 'model')).slice(0, 400));
console.log(await opencode.configure(a, s.sessionId, s));
const r = await a.prompt(s.sessionId, 'Diga oi em uma frase.', 'probe', 60000);
console.log(JSON.stringify({ stop: r.stopReason, err: r.error, text: r.agentText.slice(0, 200), ms: r.ms }));
result('probe.jsonl', 'probe-opencode', scrubObj({ r: { ...r, usageUpdates: r.usageUpdates.slice(-2) }, mock: mock.log.map((l) => ({ ...l, tools: l.tools.slice(0, 30) })) }));
await a.stop(); await mock.stop();
process.exit(0);
