// Itens 2, 3 e 4: as 10 tarefas contra o OpenCode (ACP) com o modelo de OT_MODEL.
// Uso: OT_MODEL=local/gemma4-e4b OT_PROFILE=isolated node src/run-tasks.ts <rotulo> [T1,T2,...]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent } from './lib/agent.ts';
import { startMcp } from './lib/mcp-server.ts';
import { LLAMA_PORT, MCP_PORT, OUT, SCRATCH } from './lib/paths.ts';
import { initialize, newSession, setOption, MODEL } from './lib/session.ts';
import { TASKS } from './tasks.ts';

const label = process.argv[2] ?? 'run';
const only = process.argv[3]?.split(',');
const PROFILE = process.env.OT_PROFILE ?? 'isolated'; // isolated | default | authonly
// Modelo remoto com limite de tokens por minuto (tier grátis do Google): tentar de novo a tarefa inteira quando o provedor recusar por cota,
// limite de taxa ou erro de infraestrutura, e esperar entre as tarefas. Padrão 0 e 0 = comportamento anterior.
const INFRA_RETRIES = Number(process.env.OT_INFRA_RETRIES ?? 0);
const INFRA_WAIT_MS = Number(process.env.OT_INFRA_WAIT_MS ?? 65_000);
const TASK_GAP_MS = Number(process.env.OT_TASK_GAP_MS ?? 0);
const INFRA_RE = /internal error encountered|APIError|quota|rate.?limit|resource.?exhausted|\b429\b|\b503\b|overloaded|unavailable|too many requests|ECONNRESET|fetch failed/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = Number(process.env.OT_TASK_TIMEOUT_MS ?? 480_000);
const MAX_TOOL_CALLS = 25;

const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });
const REPO = join(SCRATCH, 'repo');
const WT = join(SCRATCH, 'wt');
function ensureRepo() {
  if (!readdirSync(SCRATCH).includes('repo')) {
    mkdirSync(REPO, { recursive: true });
    sh('git', ['init', '-q', '-b', 'main'], REPO);
    sh('git', ['config', 'user.email', 'spike@example.invalid'], REPO);
    sh('git', ['config', 'user.name', 'spike'], REPO);
    writeFileSync(join(REPO, 'notes.txt'), 'foo is the placeholder\nsecond line\n');
    writeFileSync(join(REPO, 'version.txt'), '2.4.1\n');
    writeFileSync(join(REPO, 'README.md'), '# test repo\n');
    sh('git', ['add', '.'], REPO);
    sh('git', ['commit', '-q', '-m', 'init'], REPO);
  }
  if (!readdirSync(SCRATCH).includes('wt')) sh('git', ['worktree', 'add', '-q', '-b', 'wt-branch', WT], REPO);
}
const resetWt = () => { sh('git', ['reset', '-q', '--hard'], WT); sh('git', ['clean', '-fdq'], WT); };

// ---- perfil do OpenCode ----
// OT_CONFIG=lean (padrão): corta as ferramentas nativas que os testes não usam, troca o prompt de sistema por uma frase e desliga a geração
// de título. Reduz o prompt de ~12 mil para ~2,5 mil tokens, o que importa porque o llama-server só CPU desta máquina processa ~3 tokens/s.
// OT_CONFIG=default: configuração padrão do OpenCode (só o prompt de ~12 mil tokens medido com o stub).
const LEAN = {
  permission: { bash: 'deny', glob: 'deny', grep: 'deny', skill: 'deny', task: 'deny', todowrite: 'deny', webfetch: 'deny', list: 'deny' },
  agent: { build: { prompt: 'You are a coding agent working in the current directory. Use the provided tools. Be concise.' }, title: { disable: true } },
};
const EXTRA = process.env.OT_CONFIG === 'default' ? {} : LEAN;
const env: Record<string, string> = {};
if (PROFILE === 'isolated') {
  const ISO = join(SCRATCH, 'iso-profile');
  for (const d of ['data', 'config', 'db', 'cache']) mkdirSync(join(ISO, d), { recursive: true });
  env.XDG_DATA_HOME = join(ISO, 'data');
  env.XDG_CONFIG_HOME = join(ISO, 'config');
  env.XDG_CACHE_HOME = join(ISO, 'cache');
  env.OPENCODE_DB = join(ISO, 'db', 'opencode.db');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    ...EXTRA,
    provider: {
      local: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llama.cpp (local)',
        options: { baseURL: process.env.OT_BASEURL ?? `http://127.0.0.1:${LLAMA_PORT}/v1`, apiKey: 'none' },
        models: { 'gemma4-e4b': { name: 'Gemma 4 E4B (Q4_0)', tool_call: true, reasoning: false, limit: { context: Number(process.env.OT_CTX ?? 32768), output: 4096 } } },
      },
    },
  });
}

// authonly: config, cache e banco isolados (nada do ~/.config do dono entra no prompt), mas o XDG_DATA_HOME real fica, para o OpenCode achar o login
// do provedor (o spike não lê esse arquivo). Serve para modelo remoto com prompt enxuto como o do perfil isolado.
if (PROFILE === 'authonly') {
  const ISO = join(SCRATCH, 'authonly-profile');
  for (const d of ['config', 'db', 'cache']) mkdirSync(join(ISO, d), { recursive: true });
  env.XDG_CONFIG_HOME = join(ISO, 'config');
  env.XDG_CACHE_HOME = join(ISO, 'cache');
  env.OPENCODE_DB = join(ISO, 'db', 'opencode.db');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...EXTRA });
}
if (PROFILE === 'default') env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...EXTRA });
ensureRepo();
const mcp = await startMcp(join(OUT, `${label}.mcp.jsonl`), MCP_PORT);
const ag = await startAgent({ name: `${label}.acp`, cwd: WT, env });
await initialize(ag);

const results: any[] = [];
const modelInfo: any = {};
taskLoop: for (const task of TASKS) {
  if (only && !only.includes(task.id)) continue;
  if (TASK_GAP_MS && results.length) await sleep(TASK_GAP_MS);
  const attempts: { ms: number; stopReason?: string; err: string }[] = [];
  let startCalls = 0, curModel: any, curEffort: any, guard: 'timeout' | 'toolcap' | null = null, res: Awaited<ReturnType<typeof ag.prompt>>;
  for (let attempt = 0; ; attempt++) {
    resetWt();
    mcp.setTask(task.id);
    startCalls = mcp.calls.length;
    const s = await newSession(ag, WT, mcp.url, 'otheater');
    const opts0 = s.configOptions as any[];
    const modelOpt = opts0.find((o) => o.id === 'model');
    if (!modelInfo.modelListed) modelInfo.modelListed = !!modelOpt?.options.some((o: any) => o.value === MODEL);
    let final: any[];
    try {
      const r1 = await setOption(ag, s.sessionId, 'model', MODEL);
      final = r1.configOptions as any[];
      const eff = final.find((o) => o.id === 'effort');
      const vals = (eff?.options ?? []).map((o: any) => o.value);
      if (!modelInfo.effortValues) modelInfo.effortValues = vals;
      const want = ['low', 'minimal'].find((e) => vals.includes(e));
      if (eff && want) final = (await setOption(ag, s.sessionId, 'effort', want)).configOptions as any[];
    } catch (e) {
      console.error(task.id, 'falha ao escolher modelo', e);
      results.push({ id: task.id, ok: false, why: `setOption: ${String((e as any)?.message ?? e)}`, class: { setupFailed: true } });
      continue taskLoop;
    }
    curModel = final.find((o) => o.id === 'model')?.currentValue;
    curEffort = final.find((o) => o.id === 'effort')?.currentValue;

    // guarda: cancela se estourar o tempo ou o número de chamadas (laço)
    guard = null;
    const tm = setTimeout(() => { guard = 'timeout'; void ag.a.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId }); }, TIMEOUT_MS);
    const poll = setInterval(() => {
      if (!guard && mcp.calls.length - startCalls > MAX_TOOL_CALLS) { guard = 'toolcap'; void ag.a.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId }); }
    }, 1000);
    res = await ag.prompt(s.sessionId, task.prompt, `${label}:${task.id}${attempt ? `#${attempt + 1}` : ''}`);
    clearTimeout(tm); clearInterval(poll);
    // erro de infraestrutura (cota, limite de taxa, erro do provedor): não é erro do modelo
    const errText = res.stopReason === 'ERROR' ? JSON.stringify((res.response as any)?.error ?? '') + String((res.response as any)?.error?.message ?? '') : '';
    const infra = !guard && !!errText && INFRA_RE.test(errText);
    attempts.push({ ms: res.ms, stopReason: res.stopReason, err: infra ? errText.slice(0, 300) : '' });
    if (!infra || attempt >= INFRA_RETRIES) break;
    console.log(`${task.id} erro de infraestrutura (tentativa ${attempt + 1}), espera ${INFRA_WAIT_MS} ms: ${errText.slice(0, 120).replace(/\s+/g, ' ')}`);
    await sleep(INFRA_WAIT_MS);
  }
  const excluded = attempts[attempts.length - 1].err !== '';
  const calls = mcp.calls.slice(startCalls);
  const chk = task.check(calls, WT);
  // classificação
  // nome original da ferramenta (o título muda depois, p.ex. vira o nome do arquivo)
  const MCP_TOOLS = new Set(['get_sprint_info', 'create_task', 'record_findings', 'submit_result']);
  const NATIVE = new Set(['read', 'edit', 'write', 'bash', 'glob', 'grep', 'list', 'patch', 'apply_patch', 'todowrite', 'todoread', 'task', 'webfetch', 'skill', 'question']);
  const invented = res.toolCalls.filter((t) => {
    const n = (t.name0 ?? '').toLowerCase();
    if (n.startsWith('otheater_')) return !MCP_TOOLS.has(n.slice('otheater_'.length));
    return !NATIVE.has(n);
  }).map((t) => t.name0);
  const sig = (c: any) => c.tool + JSON.stringify(c.args);
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(sig(c), (counts.get(sig(c)) ?? 0) + 1);
  const repeated = [...counts.values()].some((n) => n >= 3);
  const missing = task.needs.filter((n) => !calls.some((c) => c.tool === n));
  const cls = {
    validMcp: calls.filter((c) => c.valid).length,
    badArgs: calls.filter((c) => !c.valid).length,
    inventedTool: invented.length,
    textInsteadOfCall: !!res.text.trim() && missing.length > 0 && !guard && calls.filter((c) => !c.valid).length === 0,
    loop: repeated || guard === 'toolcap' || guard === 'timeout',
    guard,
  };
  const row = {
    id: task.id, kind: task.kind, ok: chk.ok && !guard && !excluded, excluded, attempts, why: excluded ? `excluída (infraestrutura): ${attempts[attempts.length - 1].err}` : guard ? `guarda: ${guard}` : chk.why,
    stopReason: res.stopReason, ms: res.ms, firstUpdateMs: Math.round(res.firstUpdateMs ?? -1), firstTextMs: Math.round(res.firstTextChunkMs ?? -1),
    model: curModel, effort: curEffort, class: cls, missing, invented,
    acpToolCalls: res.toolCalls.map((t) => `${t.name0}(${t.kind}):${t.status}`),
    mcpCalls: calls.map((c) => ({ tool: c.tool, valid: c.valid, issues: c.issues, args: c.args })),
    text: res.text.slice(0, 400), usage: res.usage, updateCounts: res.updateCounts,
  };
  results.push(row);
  console.log(`${task.id} ${row.excluded ? 'EXCL' : row.ok ? 'OK ' : 'FALHA'} tent=${attempts.length} ${res.ms}ms stop=${res.stopReason} valid=${cls.validMcp} bad=${cls.badArgs} inv=${cls.inventedTool} txt=${cls.textInsteadOfCall} loop=${cls.loop} ${row.why}`);
  writeFileSync(join(OUT, `${label}.results.json`), JSON.stringify({ label, profile: PROFILE, model: MODEL, modelInfo, results }, null, 1));
}
await ag.close();
await mcp.close();
const okN = results.filter((r) => r.ok).length;
const exclN = results.filter((r) => r.excluded).length;
console.log(`\n${label}: ${okN}/${results.length - exclN} ok (${exclN} excluídas por infraestrutura)`);
process.exit(0);
