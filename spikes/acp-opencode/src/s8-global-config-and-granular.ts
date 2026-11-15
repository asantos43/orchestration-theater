// Item 8d (permissões pelo ACP) para o OpenCode: config global isolada, padrão de permissão e granularidade.
//   iso   : repete e1..e5 do s7 com XDG_CONFIG_HOME apontado para uma pasta vazia (a global do dono fica fora).
//   def   : sem nenhuma config de permissão, com a global isolada: o padrão é ask ou allow? (bash e edit)
//   par   : opencode.json do cwd bash=deny contra OPENCODE_PERMISSION bash=allow
//   gran  : OPENCODE_PERMISSION com padrões de comando (git status*, touch *)
// Uso: OT_COUNTER=<abs>/out/prompt-count-item8d.json OT_MAX_PROMPTS=15 SPIKE_SCRATCH=<scratchpad>/item8d-opencode/opencode \
//        OT_XDG_CONFIG=<scratchpad>/item8d-opencode/xdg-config-empty node src/s8-global-config-and-granular.ts iso|def|par|gran|all [caso]
// Política do cliente: allow (escolhe allow_once). Cada caso é 1 execução; o arquivo é conferido no disco.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent, type PromptResult } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';

if (!process.env.OT_COUNTER) throw new Error('defina OT_COUNTER e OT_MAX_PROMPTS (contador próprio do item 8d)');
const XDG = process.env.OT_XDG_CONFIG;
if (!XDG) throw new Error('defina OT_XDG_CONFIG (pasta usada como XDG_CONFIG_HOME, sem config do dono)');
const phase = process.argv[2] ?? 'all';
const only = process.argv[3];
const out: Record<string, unknown> = {};

const allow = (req: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
  const opt = req.options.find((o) => ['allow_once', 'allow_always'].includes(o.kind));
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
};

const bash = (id: string) =>
  `Use the bash tool to run exactly this command: touch ${id}.txt . If you have no bash tool or it is refused, reply NOBASH.`;
const edit = (id: string) =>
  `Use the write or edit tool (not bash) to create a file named ${id}.txt containing the word hi. If you have no such tool or it is refused, reply NOEDIT.`;
const bashAlone = (id: string) =>
  `Use the bash tool to run exactly one command, with nothing chained before or after it (no ls, no &&): touch ${id}.txt . If you have no bash tool or it is refused, reply NOBASH.`;
const gitStatus = `Use the bash tool to run exactly this command: git status . If you have no bash tool or it is refused, reply NOBASH.`;

const json = (wt: string, permission: object) =>
  writeFileSync(join(wt, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission }, null, 2));
const noJson = (wt: string) => rmSync(join(wt, 'opencode.json'), { force: true });
const summary = (r: PromptResult) => ({
  stopReason: r.stopReason,
  ms: r.ms,
  toolCalls: r.toolCalls,
  nPermissionRequests: r.permissionRequests.length,
  permissionRequests: r.permissionRequests.map((p) => ({
    title: p.toolCall.title,
    kind: p.toolCall.kind,
    rawInput: p.toolCall.rawInput,
    options: p.options.map((o) => o.kind),
  })),
  text: r.text.slice(0, 200),
});

interface Case {
  id: string;
  phase: string;
  wt: number;
  note: string;
  prompt: (id: string) => string;
  /** arquivo esperado (nome); undefined = não confere */
  proof?: (id: string) => string;
  json?: object;
  env?: Record<string, string>;
}
const P = (o: object) => JSON.stringify(o);
const CASES: Case[] = [
  // 1. e1..e5 do s7, com a global isolada
  { id: 'e1-content-deny', phase: 'iso', wt: 0, prompt: bash, note: 'só OPENCODE_CONFIG_CONTENT {"permission":{"bash":"deny","edit":"allow"}}', env: { OPENCODE_CONFIG_CONTENT: P({ permission: { bash: 'deny', edit: 'allow' } }) } },
  {
    id: 'e2-json-allow-vs-content-deny', phase: 'iso', wt: 1, prompt: bash,
    note: 'opencode.json do cwd bash=allow contra OPENCODE_CONFIG_CONTENT bash=deny',
    json: { bash: 'allow' }, env: { OPENCODE_CONFIG_CONTENT: P({ permission: { bash: 'deny' } }) },
  },
  {
    id: 'e3-json-allow-vs-permission-deny', phase: 'iso', wt: 2, prompt: bash,
    note: 'opencode.json do cwd bash=allow contra OPENCODE_PERMISSION bash=deny',
    json: { bash: 'allow' }, env: { OPENCODE_PERMISSION: P({ bash: 'deny' }) },
  },
  {
    id: 'e4-permission-allow-vs-content-deny', phase: 'iso', wt: 0, prompt: bash,
    note: 'OPENCODE_PERMISSION bash=allow contra OPENCODE_CONFIG_CONTENT bash=deny (as duas por env)',
    env: { OPENCODE_PERMISSION: P({ bash: 'allow' }), OPENCODE_CONFIG_CONTENT: P({ permission: { bash: 'deny' } }) },
  },
  {
    id: 'e5-json-deny-project-config-off', phase: 'iso', wt: 1, prompt: bash,
    note: 'opencode.json do cwd bash=deny + OPENCODE_DISABLE_PROJECT_CONFIG=1 (o json deve ser ignorado)',
    json: { bash: 'deny' }, env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
  },
  // 2. padrão sem config de permissão
  { id: 'd1-default-bash', phase: 'def', wt: 2, prompt: bash, note: 'nenhuma config de permissão (global isolada, sem json, sem env): padrão do bash' },
  { id: 'd2-default-edit', phase: 'def', wt: 0, prompt: edit, note: 'nenhuma config de permissão (global isolada, sem json, sem env): padrão do edit/write' },
  // 3. o par que faltou
  {
    id: 'p1-json-deny-vs-permission-allow', phase: 'par', wt: 1, prompt: bash,
    note: 'opencode.json do cwd bash=deny contra OPENCODE_PERMISSION bash=allow',
    json: { bash: 'deny' }, env: { OPENCODE_PERMISSION: P({ bash: 'allow' }) },
  },
  // 4. granularidade
  {
    id: 'g1-deny-star-allow-gitstatus-gitstatus', phase: 'gran', wt: 2, prompt: () => gitStatus,
    proof: () => '',
    note: 'OPENCODE_PERMISSION {"bash":{"*":"deny","git status*":"allow"}}, pedindo `git status`',
    env: { OPENCODE_PERMISSION: P({ bash: { '*': 'deny', 'git status*': 'allow' } }) },
  },
  {
    id: 'g2-deny-star-allow-gitstatus-touch', phase: 'gran', wt: 0, prompt: bash,
    note: 'mesmo OPENCODE_PERMISSION, pedindo `touch` (deve cair em "*":"deny")',
    env: { OPENCODE_PERMISSION: P({ bash: { '*': 'deny', 'git status*': 'allow' } }) },
  },
  {
    id: 'g2b-deny-star-allow-gitstatus-touch-alone', phase: 'gran', wt: 2, prompt: bashAlone,
    note: 'mesmo OPENCODE_PERMISSION, pedindo só `touch` sem encadear (repete o g2, que o modelo encadeou com `ls .`)',
    env: { OPENCODE_PERMISSION: P({ bash: { '*': 'deny', 'git status*': 'allow' } }) },
  },
  {
    id: 'g3-allow-star-ask-touch', phase: 'gran', wt: 1, prompt: bash,
    note: 'OPENCODE_PERMISSION {"bash":{"*":"allow","touch *":"ask"}}, pedindo `touch` (deve chegar request_permission)',
    env: { OPENCODE_PERMISSION: P({ bash: { '*': 'allow', 'touch *': 'ask' } }) },
  },
];

for (const c of CASES) {
  if (phase !== 'all' && phase !== c.phase) continue;
  if (only && only !== c.id) continue;
  const wt = WT[c.wt]!;
  noJson(wt);
  if (c.json) json(wt, c.json);
  const proof = join(wt, `${c.id}.txt`);
  rmSync(proof, { force: true });
  // XDG_CONFIG_HOME isolado em todos os casos; XDG_DATA_HOME e o resto do ambiente ficam como estão (o login mora em XDG_DATA_HOME)
  const env = { XDG_CONFIG_HOME: XDG, ...c.env };
  const ag = await startAgent({ name: `s8-${c.id}`, cwd: wt, permission: allow, env });
  try {
    await initialize(ag);
    const s = await newSession(ag, wt);
    await pickCheap(ag, s.sessionId);
    const r = await ag.prompt(s.sessionId, c.prompt(c.id), `s8-${c.id}`);
    out[c.id] = { note: c.note, ...summary(r), ...(c.proof ? {} : { arquivoCriado: existsSync(proof) }) };
  } catch (e) {
    out[c.id] = { note: c.note, error: String((e as any)?.message ?? e).slice(0, 300) };
  }
  await ag.close();
  noJson(wt);
  console.log(c.id, JSON.stringify(out[c.id]));
}
const name = only ? `s8.${only}.json` : phase === 'all' ? 's8.all.json' : `s8.${phase}.json`;
writeFileSync(join(OUT, name), JSON.stringify(out, null, 1));
process.exit(0);
