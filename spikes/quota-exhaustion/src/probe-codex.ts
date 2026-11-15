// Sonda: codex-acp contra o mock Responses API, 1 prompt sem erro.
import { join } from 'node:path';
import { Adapter, OUT, PORTS, WT, configOptionValues, ensureRepo, result, scrubObj } from './lib.ts';
import { startMock } from './mock.ts';
import { codex } from './clients.ts';

ensureRepo();
const mock = await startMock('responses', PORTS.codex, join(OUT, 'probe-codex.mock.jsonl'));
const a = Adapter.start(codex.spec('probe-codex'));
const init: any = await a.initialize();
console.log('auth', JSON.stringify(init.authMethods?.map((m: any) => m.id)));
let s: any;
try {
  s = await a.newSession(WT(2));
} catch (e: any) {
  console.log('session/new falhou', e.code, e.message, JSON.stringify(e.data));
  await a.stop(); await mock.stop(); process.exit(1);
}
console.log('config', JSON.stringify(s.configOptions?.map((o: any) => ({ id: o.id, cur: o.currentValue }))));
console.log('modes', configOptionValues(s, 'mode'), 'models', configOptionValues(s, 'model'));
console.log(await codex.configure(a, s.sessionId, s));
const r = await a.prompt(s.sessionId, 'Diga oi em uma frase.', 'probe', 60000);
result('probe.jsonl', 'probe-codex', scrubObj({ r: { ...r, usageUpdates: r.usageUpdates.slice(-2) }, mock: mock.log.map((l) => ({ ...l, tools: l.tools.slice(0, 30) })) }));
await a.stop(); await mock.stop();
process.exit(0);
