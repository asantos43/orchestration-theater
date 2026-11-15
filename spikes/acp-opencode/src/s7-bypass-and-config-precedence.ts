// Item 8 (permissões pelo ACP) para o OpenCode.
//   catalog : sem prompt. Lista modos e config options do `session/new` (procura modo/opção de bypass) e `opencode acp --help` já foi lido à mão.
//   prec    : gasta prompts (contador próprio). OPENCODE_CONFIG_CONTENT, opencode.json do cwd, OPENCODE_PERMISSION e
//             OPENCODE_DISABLE_PROJECT_CONFIG: o bash some? Quem vence?
// Uso: OT_COUNTER=<abs>/out/prompt-count-item8.json OT_MAX_PROMPTS=8 SPIKE_SCRATCH=<scratchpad>/item8/opencode \
//        node src/s7-bypass-and-config-precedence.ts catalog|prec [caso]
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent, type PromptResult } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';

if (!process.env.OT_COUNTER) throw new Error('defina OT_COUNTER e OT_MAX_PROMPTS (contador próprio do item 8)');
const phase = process.argv[2] ?? 'catalog';
const only = process.argv[3];
const out: Record<string, unknown> = {};

const allow = (req: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
  const opt = req.options.find((o) => ['allow_once', 'allow_always'].includes(o.kind));
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
};

if (phase === 'catalog') {
  const ag = await startAgent({ name: 's7-catalog', cwd: WT[0]!, permission: allow });
  const init = await initialize(ag);
  const s = (await newSession(ag, WT[0]!)) as unknown as Record<string, any>;
  const opts = (s.configOptions ?? []) as any[];
  out.initialize = { agentInfo: (init as any).agentInfo, agentCapabilities: (init as any).agentCapabilities };
  out.modes = s.modes ?? null;
  out.configOptions = opts.map((o) => ({
    id: o.id,
    name: o.name,
    category: o.category,
    type: o.type,
    currentValue: o.currentValue,
    nOptions: o.options?.length,
    values: o.id === 'model' ? `(${o.options?.length} modelos)` : (o.options ?? []).map((x: any) => x.value ?? x.options?.map((y: any) => y.value)),
  }));
  out.topLevelKeys = Object.keys(s);
  // tenta ligar um "bypass" por nome em set_mode e set_config_option (ids que não existem devem falhar)
  const tries: Record<string, unknown> = {};
  for (const m of ['bypassPermissions', 'bypass', 'yolo', 'auto', 'allow-all', 'build', 'plan']) {
    try {
      await ag.a.request(acp.methods.agent.session.setMode, { sessionId: s.sessionId, modeId: m });
      tries[`setMode:${m}`] = 'ok';
    } catch (e) {
      tries[`setMode:${m}`] = String((e as any)?.message ?? e).slice(0, 160);
    }
  }
  for (const [id, v] of [['permission', 'allow'], ['mode', 'bypass']] as const) {
    try {
      await ag.a.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: id, value: v });
      tries[`setConfigOption:${id}=${v}`] = 'ok';
    } catch (e) {
      tries[`setConfigOption:${id}=${v}`] = String((e as any)?.message ?? e).slice(0, 160);
    }
  }
  out.tentativasDeBypass = tries;
  await ag.close();
  writeFileSync(join(OUT, 's7.catalog.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

const bash = (id: string) =>
  `Use the bash tool to run exactly this command: touch ${id}.txt . If you have no bash tool or it is refused, reply NOBASH.`;
const json = (wt: string, permission: object) =>
  writeFileSync(join(wt, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission }, null, 2));
const noJson = (wt: string) => rmSync(join(wt, 'opencode.json'), { force: true });
const summary = (r: PromptResult) => ({
  stopReason: r.stopReason,
  ms: r.ms,
  toolCalls: r.toolCalls,
  nPermissionRequests: r.permissionRequests.length,
  text: r.text.slice(0, 160),
});

interface Case {
  id: string;
  wt: number;
  note: string;
  json?: object;
  env?: Record<string, string>;
}
const CASES: Case[] = [
  { id: 'e1-content-deny', wt: 0, note: 'só OPENCODE_CONFIG_CONTENT {"permission":{"bash":"deny","edit":"allow"}}', env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'deny', edit: 'allow' } }) } },
  {
    id: 'e2-json-allow-vs-content-deny', wt: 1,
    note: 'opencode.json do cwd bash=allow contra OPENCODE_CONFIG_CONTENT bash=deny',
    json: { bash: 'allow' },
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'deny' } }) },
  },
  {
    id: 'e3-json-allow-vs-permission-deny', wt: 2,
    note: 'opencode.json do cwd bash=allow contra OPENCODE_PERMISSION bash=deny',
    json: { bash: 'allow' },
    env: { OPENCODE_PERMISSION: JSON.stringify({ bash: 'deny' }) },
  },
  {
    id: 'e4-permission-allow-vs-content-deny', wt: 0,
    note: 'OPENCODE_PERMISSION bash=allow contra OPENCODE_CONFIG_CONTENT bash=deny (as duas por env)',
    env: { OPENCODE_PERMISSION: JSON.stringify({ bash: 'allow' }), OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'deny' } }) },
  },
  {
    id: 'e5-json-deny-project-config-off', wt: 1,
    note: 'opencode.json do cwd bash=deny + OPENCODE_DISABLE_PROJECT_CONFIG=1 (o json deve ser ignorado)',
    json: { bash: 'deny' },
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
  },
];

for (const c of CASES) {
  if (only && only !== c.id) continue;
  const wt = WT[c.wt]!;
  noJson(wt);
  if (c.json) json(wt, c.json);
  const proof = join(wt, `${c.id}.txt`);
  rmSync(proof, { force: true });
  const ag = await startAgent({ name: `s7-${c.id}`, cwd: wt, permission: allow, env: c.env });
  try {
    await initialize(ag);
    const s = await newSession(ag, wt);
    await pickCheap(ag, s.sessionId);
    const r = await ag.prompt(s.sessionId, bash(c.id), `s7-${c.id}`);
    out[c.id] = { note: c.note, ...summary(r), arquivoCriado: existsSync(proof) };
  } catch (e) {
    out[c.id] = { note: c.note, error: String((e as any)?.message ?? e).slice(0, 300) };
  }
  await ag.close();
  noJson(wt);
  console.log(c.id, JSON.stringify(out[c.id]));
}
writeFileSync(join(OUT, only ? `s7.prec.${only}.json` : 's7.prec.json'), JSON.stringify(out, null, 1));
process.exit(0);
