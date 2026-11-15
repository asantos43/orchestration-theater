// Item 8: perfil isolado (XDG_DATA_HOME, XDG_CONFIG_HOME, OPENCODE_DB em pastas vazias). Sem login.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent } from './lib/agent.ts';
import { OUT, SCRATCH, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';

const ISO = join(SCRATCH, 'iso-profile');
rmSync(ISO, { recursive: true, force: true });
for (const d of ['data', 'config', 'db']) mkdirSync(join(ISO, d), { recursive: true });
const env = { XDG_DATA_HOME: join(ISO, 'data'), XDG_CONFIG_HOME: join(ISO, 'config'), OPENCODE_DB: join(ISO, 'db', 'opencode.db') };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tree = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(d, e.name)) : [join(d, e.name).slice(ISO.length + 1)]));
const out: Record<string, any> = {};

// auth list e models com o perfil isolado (só leitura; nenhum login)
try {
  out.authList = strip(execFileSync('opencode', ['auth', 'list'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })).split('\n').filter((l) => !/key|token/i.test(l)).join('\n');
} catch (e: any) { out.authList = `erro: ${strip(String(e.stderr || e.message)).slice(0, 300)}`; }
try {
  const m = execFileSync('opencode', ['models'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 }).trim().split('\n');
  out.models = { n: m.length, providers: [...new Set(m.map((x) => x.split('/')[0]))], sample: m.slice(0, 5) };
} catch (e: any) { out.models = `erro: ${strip(String(e.stderr || e.message)).slice(0, 300)}`; }

const ag = await startAgent({ name: 's6-isolated', cwd: WT[2], env });
const init = await initialize(ag);
out.init = { authMethods: init.authMethods, loadSession: init.agentCapabilities?.loadSession };
const s = await newSession(ag, WT[2]);
const opts = s.configOptions as any[];
const model = opts.find((o) => o.id === 'model');
out.sessionNew = { currentModel: model.currentValue, nModels: model.options.length, providers: [...new Set(model.options.map((o: any) => String(o.value).split('/')[0]))] };
const list = await ag.a.request(acp.methods.agent.session.list, {});
out.sessionList = { n: (list as any).sessions?.length };
// o catálogo isolado tem algum modelo gratuito do gateway? (sem chave)
const free = model.options.map((o: any) => o.value).filter((v: string) => /^opencode\/.*-free$/.test(v));
out.freeGatewayModels = free.slice(0, 5);
// 1 prompt: com o modelo padrão do perfil isolado (mostra o erro de ausência de login, se houver)
const r = await ag.prompt(s.sessionId, 'Reply with the single word: ok', 's6-isolated-default-model');
out.promptDefaultModel = { stopReason: r.stopReason, ms: r.ms, text: r.text.slice(0, 80), error: (r.response as any).error ? { message: String((r.response as any).error?.message ?? ''), data: (r.response as any).error?.data } : null };
await ag.close();
out.filesCreatedInIsolatedProfile = tree(ISO).map((f) => ({ f, bytes: statSync(join(ISO, f)).size })).slice(0, 40);
writeFileSync(join(OUT, 's6.result.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
