// Item 8 (permissões pelo ACP) para o Codex.
//   catalog : sem prompt. Lista modos/config options do session/new e testa se algum override
//             (CODEX_CONFIG, INITIAL_AGENT_MODE, `-c` via CODEX_PATH embrulhado) tira `agent-full-access`
//             do catálogo ou faz o set_config_option falhar. Não mexe em ~/.codex/config.toml.
//   modes   : gasta prompts. Modos `agent` ("Auto review") e `agent-full-access`: escreve um arquivo na worktree,
//             um em pasta da scratchpad (em /tmp) e um em pasta FORA de /tmp e da worktree (out/ do spike).
//   variant : gasta 1 prompt. Mesmo teste, no modo agent-full-access, com um override de `-c` aplicado.
// Uso: SPIKE_SCRATCH=<scratchpad>/item8/codex node src/s8-agent-modes-and-catalog.ts catalog|modes|variant
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, BUNDLED_CODEX, OUT, SCRATCH, WT, newSession, result, runPrompt, sleep } from './lib.ts';

const phase = process.argv[2] ?? 'catalog';
const only = process.argv[3]; // filtro opcional por id de caso

// pastas de escrita
const TMP_OUT = join(SCRATCH, 'outside-tmp'); // dentro de /tmp (a scratchpad): o workspace-write do adaptador libera /tmp
const REAL_OUT = join(OUT, 'item8-outside'); // fora de /tmp e fora da worktree (pasta ignorada pelo git, dentro do spike)
mkdirSync(TMP_OUT, { recursive: true });
mkdirSync(REAL_OUT, { recursive: true });

/** `codex` embrulhado: mesmo binário empacotado, com `-c` extras (CODEX_PATH aponta para o script) */
function wrapper(name: string, overrides: string[]): string {
  const p = join(SCRATCH, `codex-wrap-${name}.sh`);
  const args = overrides.map((o) => `-c '${o}'`).join(' ');
  writeFileSync(p, `#!/bin/sh\nexec "${BUNDLED_CODEX}" ${args} "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

interface Variant {
  id: string;
  note: string;
  env?: Record<string, string>;
  overrides?: string[];
}
const VARIANTS: Variant[] = [
  { id: 'base', note: 'sem override' },
  { id: 'env-initial-mode', note: 'INITIAL_AGENT_MODE=read-only', env: { INITIAL_AGENT_MODE: 'read-only' } },
  { id: 'env-config-sandbox', note: 'CODEX_CONFIG={"sandbox_mode":"read-only"}', env: { CODEX_CONFIG: '{"sandbox_mode":"read-only"}' } },
  {
    id: 'env-config-allowed',
    note: 'CODEX_CONFIG={"allowed_sandbox_modes":["read-only","workspace-write"]}',
    env: { CODEX_CONFIG: '{"allowed_sandbox_modes":["read-only","workspace-write"]}' },
  },
  {
    id: 'dash-c-allowed',
    note: '-c allowed_sandbox_modes=["read-only","workspace-write"] (via CODEX_PATH embrulhado)',
    overrides: ['allowed_sandbox_modes=["read-only","workspace-write"]'],
  },
  {
    id: 'dash-c-sandbox',
    note: '-c sandbox_mode="read-only" -c approval_policy="on-request" (via CODEX_PATH embrulhado)',
    overrides: ['sandbox_mode="read-only"', 'approval_policy="on-request"'],
  },
];

function startVariant(v: Variant, tag: string): Adapter {
  const env: Record<string, string> = { ...(v.env ?? {}) };
  if (v.overrides) env.CODEX_PATH = wrapper(v.id, v.overrides);
  return Adapter.start({ name: `s8-${tag}-${v.id}`, env });
}

type Opt = { id: string; currentValue?: string; options?: unknown[] };
function modeCatalog(s: { configOptions?: unknown; modes?: unknown }) {
  const opts = ((s.configOptions as Opt[] | null | undefined) ?? []).find((o) => o.id === 'mode');
  const flat: string[] = [];
  const walk = (xs: unknown[] | undefined) => {
    for (const x of xs ?? []) {
      const o = x as { value?: string; options?: unknown[] };
      if (o.value) flat.push(o.value);
      if (o.options) walk(o.options);
    }
  };
  walk(opts?.options);
  const modes = s.modes as { currentModeId?: string; availableModes?: { id: string }[] } | null | undefined;
  return {
    configMode: { current: opts?.currentValue, values: flat },
    modes: { current: modes?.currentModeId, ids: (modes?.availableModes ?? []).map((m) => m.id) },
    configIds: ((s.configOptions as Opt[] | null | undefined) ?? []).map((o) => o.id),
  };
}

if (phase === 'catalog') {
  const out: Record<string, unknown> = {};
  for (const v of VARIANTS) {
    if (only && only !== v.id) continue;
    const a = startVariant(v, 'cat');
    const rec: Record<string, unknown> = { note: v.note };
    try {
      await a.initialize();
      const s = await a.agent.request(acp.methods.agent.session.new, { cwd: WT(2), mcpServers: [] });
      rec.catalog = modeCatalog(s as never);
      for (const m of ['agent-full-access', 'read-only']) {
        try {
          const r = await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: 'mode', value: m });
          rec[`set_${m}`] = { ok: true, current: modeCatalog(r as never).configMode.current };
        } catch (e) {
          rec[`set_${m}`] = { ok: false, error: String((e as Error).message ?? e).slice(0, 300) };
        }
      }
    } catch (e) {
      rec.error = String((e as Error).message ?? e).slice(0, 400);
    }
    rec.stderr = a.stderrText.slice(0, 500);
    out[v.id] = rec;
    await a.stop();
    await sleep(300);
  }
  result('s8 catalog: modos por variante de override', out);
  process.exit(0);
}

const slim = (r: Awaited<ReturnType<typeof runPrompt>>) => ({
  stopReason: r.stopReason,
  ms: r.ms,
  kinds: r.kinds,
  agentText: r.agentText,
  commands: r.tools.filter((t) => t.ev === 'tool_call').map((t) => (t.rawInput as { command?: unknown } | undefined)?.command ?? t.title),
  toolStatus: r.tools.filter((t) => t.ev === 'tool_call_update').map((t) => ({ status: t.status, out: t.rawOutput })),
  permissions: r.permissions.map((p) => ({
    title: (p.toolCall as { title?: string }).title,
    meta: (p as { _meta?: unknown })._meta,
    options: p.options.map((o) => `${o.kind}:${o.name}`),
  })),
});

/** um prompt que escreve 3 arquivos, em 3 comandos separados */
function writePrompt(tag: string, wt: string, escalate = false) {
  const f1 = join(wt, `wt-${tag}.txt`);
  const f2 = join(TMP_OUT, `tmp-${tag}.txt`);
  const f3 = join(REAL_OUT, `real-${tag}.txt`);
  // com `escalate`, o mesmo texto do s3b-perm.ts (1 arquivo, pede aprovação se o sandbox bloquear): a 1ª rodada, com 3 comandos, não escalou
  const text = escalate
    ? `Create the file ${f3} with the content 'hi', using a shell command. If the sandbox blocks it, ask for approval to run it outside the sandbox. If approval is denied, stop and report that.`
    : `Run exactly three separate shell commands, one after the other, each creating one file with the content 'hi':\n` +
      `1. echo hi > ${f1}\n2. echo hi > ${f2}\n3. echo hi > ${f3}\n` +
      `Run all three even if an earlier one fails or is not approved, then report in one line per file whether it was created. Do not use any other tool.`;
  return { text, f1, f2, f3 };
}
const exists = (p: string) => existsSync(p);

async function runCase(name: string, v: Variant, mode: 'agent' | 'agent-full-access', decision: 'reject' | 'allow', wtN: number, escalate = false) {
  const tag = `${mode === 'agent' ? 'ag' : 'fa'}-${decision}-${v.id}${escalate ? '-esc' : ''}`;
  const a = startVariant(v, 'run');
  const rec: Record<string, unknown> = { variante: v.note, modo: mode, politicaDoCliente: decision };
  try {
    await a.initialize();
    const s = await newSession(a, WT(wtN), undefined, { model: 'gpt-6-luna', reasoning_effort: 'low', mode });
    rec.catalogo = modeCatalog(s as never).configMode;
    a.permission = decision;
    const { text, f1, f2, f3 } = writePrompt(tag, WT(wtN), escalate);
    for (const f of [f1, f2, f3]) rmSync(f, { force: true });
    const r = await runPrompt(a, s.sessionId, text, `item8-${name}-${tag}`);
    rec.prompt = slim(r);
    rec.arquivos = { naWorktree: exists(f1), emTmpScratchpad: exists(f2), foraDeTmpEDaWorktree: exists(f3) };
  } catch (e) {
    rec.error = String((e as Error).message ?? e).slice(0, 500);
  }
  rec.stderr = a.stderrText.slice(0, 400);
  await a.stop();
  result(`s8 ${name}: ${tag}`, rec);
  await sleep(500);
}

const base = VARIANTS[0]!;
if (phase === 'modes') {
  // 3º campo: pede explicitamente para escalar quando o sandbox bloquear (a 1ª rodada, sem o pedido, não escalou)
  const plan: ['agent' | 'agent-full-access', 'reject' | 'allow', boolean][] = [
    ['agent', 'reject', false],
    ['agent', 'allow', false],
    ['agent-full-access', 'reject', false],
    ['agent', 'reject', true],
    ['agent', 'allow', true],
  ];
  let i = 1;
  for (const [mode, decision, esc] of plan) {
    if (only && only !== `${mode}:${decision}:${esc ? 'esc' : 'plain'}`) continue;
    await runCase('modes', base, mode, decision, i, esc);
    i = (i % 3) + 1;
  }
  process.exit(0);
}

if (phase === 'variant') {
  // só depois de ver o resultado de `catalog`: escolhe a variante por id
  const v = VARIANTS.find((x) => x.id === only);
  if (!v) throw new Error(`variante desconhecida: ${only}`);
  await runCase('variant', v, 'agent-full-access', 'reject', 3);
  process.exit(0);
}
