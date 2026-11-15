// Item 8d (permissões pelo ACP) para o Codex.
//   req      : sem modelo real. `requirements.toml` num CODEX_HOME isolado (provedor falso, chave falsa, sem auth.json):
//              o Codex lê o arquivo? catálogo de modos, set_config_option, o que o `turn/start` manda, rebaixamento.
//   reviewer : gasta prompts reais (login padrão do dono). Revisor automático do modo `agent` com outras classes de
//              comando: rede (curl), remoção recursiva (rm -rf) e `sudo -n true`. Argumento 2 filtra: net|rm|sudo.
//              Argumento 3: ask (pede aprovação se o sandbox bloquear), escalate (pede a escalada já na 1ª chamada) ou
//              neutral (só pede o comando).
//   readonly : gasta 2 prompts reais. Modo `read-only`, as 3 escritas do s8, política do cliente reject e depois allow.
//   cleanup  : apaga, um por nome, os arquivos de prova de out/item8d-outside/.
// Uso: SPIKE_SCRATCH=<scratchpad>/item8d-codex node src/s9-requirements-reviewer-readonly.ts req|reviewer|readonly|cleanup
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, BUNDLED_CODEX, OUT, REPO, SCRATCH, WT, newSession, result, runPrompt, sleep } from './lib.ts';
import { startMock } from '../../quota-exhaustion/src/mock.ts';

const phase = process.argv[2] ?? 'req';
const only = process.argv[3];
const style = process.argv[4] ?? 'ask';

const TMP_OUT = join(SCRATCH, 'outside-tmp'); // dentro de /tmp
const REAL_OUT = join(OUT, 'item8d-outside'); // fora de /tmp e da worktree (pasta ignorada pelo git)
const TEE_DIR = join(SCRATCH, 'tee');
mkdirSync(TMP_OUT, { recursive: true });
mkdirSync(REAL_OUT, { recursive: true });
mkdirSync(TEE_DIR, { recursive: true });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', ...args], { cwd, stdio: 'pipe' });
function ensureRepo() {
  if (!existsSync(join(REPO, '.git'))) {
    mkdirSync(REPO, { recursive: true });
    git(REPO, 'init', '-q', '-b', 'master');
    writeFileSync(join(REPO, 'README.md'), 'hi\n');
    git(REPO, 'add', '.');
    git(REPO, 'commit', '-q', '-m', 'init');
  }
  for (const n of [1, 2, 3]) if (!existsSync(WT(n))) git(REPO, 'worktree', 'add', '-q', '-b', `wt${n}`, WT(n));
}

/** `codex` embrulhado que copia (tee) as linhas trocadas entre o adaptador e o `codex app-server` num arquivo da scratchpad */
function teeWrapper(tag: string, overrides: string[] = []) {
  const logFile = join(TEE_DIR, `${tag}.jsonl`);
  writeFileSync(logFile, '');
  const p = join(SCRATCH, `codex-tee-${tag}.mjs`);
  writeFileSync(
    p,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(logFile)};
const args = [${JSON.stringify(BUNDLED_CODEX)}, ...${JSON.stringify(overrides.flatMap((o) => ['-c', o]))}, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
function tap(dir, stream, sink) {
  let buf = '';
  stream.on('data', (d) => {
    sink.write(d);
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) { appendFileSync(LOG, JSON.stringify({ ms: Date.now(), dir, line: buf.slice(0, i) }) + '\\n'); buf = buf.slice(i + 1); }
  });
}
tap('toCodex', process.stdin, child.stdin);
tap('fromCodex', child.stdout, process.stdout);
child.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`,
  );
  chmodSync(p, 0o755);
  return { path: p, logFile };
}

type Msg = { ms: number; dir: string; msg: any };
function readTee(logFile: string): Msg[] {
  const out: Msg[] = [];
  const idMethod = new Map<string, string>();
  for (const l of readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l) as { ms: number; dir: string; line: string };
    let msg: any;
    try {
      msg = JSON.parse(r.line);
    } catch {
      continue;
    }
    if (msg.method && msg.id !== undefined) idMethod.set(`${r.dir}:${msg.id}`, msg.method);
    // respostas: o método vem do pedido que foi na direção oposta
    if (!msg.method && msg.id !== undefined) {
      const opposite = r.dir === 'fromCodex' ? 'toCodex' : 'fromCodex';
      msg._reqMethod = idMethod.get(`${opposite}:${msg.id}`);
    }
    out.push({ ms: r.ms, dir: r.dir, msg });
  }
  return out;
}
const NOISY = /^(account\/|mcpServer\/|thread\/tokenUsage|item\/agentMessage\/delta|item\/reasoning|item\/commandExecution\/outputDelta|thread\/started|remoteControl|warning|skills\/|app\/list|plugin\/|configWarning|model\/)/;
/** versão filtrada para out/: sem e-mail/contas, sem ruído de streaming */
function filterTee(msgs: Msg[]): Msg[] {
  return msgs.filter((m) => {
    const method = m.msg.method ?? m.msg._reqMethod ?? '';
    return !NOISY.test(method);
  });
}
function saveTee(name: string, logFile: string) {
  const f = filterTee(readTee(logFile));
  writeFileSync(join(OUT, `${name}.jsonl`), f.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return f;
}
/** params de turn/start sem o texto do prompt */
function turnStarts(msgs: Msg[]) {
  return msgs
    .filter((m) => m.dir === 'toCodex' && m.msg.method === 'turn/start')
    .map((m) => {
      const p = { ...m.msg.params };
      delete p.input;
      return { id: m.msg.id, params: p };
    });
}
function turnStartReplies(msgs: Msg[]) {
  return msgs.filter((m) => m.msg._reqMethod === 'turn/start').map((m) => ({ error: m.msg.error, result: m.msg.result ? Object.keys(m.msg.result) : undefined }));
}
function methodCounts(msgs: Msg[]) {
  const c: Record<string, number> = {};
  for (const m of msgs) {
    const k = m.msg.method ? `${m.dir === 'fromCodex' ? '<-' : '->'}${m.msg.method}` : `reply:${m.msg._reqMethod ?? '?'}`;
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}
/** execuções de comando vistas pelo app-server (do ponto de vista do Codex, não do ACP) */
function execItems(msgs: Msg[]) {
  const items = new Map<string, any>();
  for (const m of msgs) {
    if (m.dir !== 'fromCodex') continue;
    const it = m.msg.params?.item;
    if ((m.msg.method === 'item/started' || m.msg.method === 'item/completed') && it?.type === 'commandExecution') {
      const cur = items.get(it.id) ?? { id: String(it.id).slice(0, 14) };
      items.set(it.id, {
        ...cur,
        command: it.command,
        [m.msg.method === 'item/started' ? 'started' : 'completed']: m.ms,
        status: it.status,
        exitCode: it.exitCode,
        source: it.source,
        output: typeof it.aggregatedOutput === 'string' ? it.aggregatedOutput.slice(0, 300) : it.aggregatedOutput,
      });
    }
  }
  return [...items.values()];
}
function approvalMessages(msgs: Msg[]) {
  return msgs
    .filter((m) => /approval|guardian|review/i.test(m.msg.method ?? ''))
    .map((m) => ({ dir: m.dir, method: m.msg.method, params: JSON.stringify(m.msg.params)?.slice(0, 500) }));
}

// ---------- parte 1: requirements.toml ----------
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const CODEX_CONFIG_REAL = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

function isolatedHome(name: string, withRequirements: boolean, port: number) {
  const home = join(SCRATCH, name);
  mkdirSync(home, { recursive: true });
  // provedor falso (como o spike quota-exhaustion): Responses API local, chave falsa por variável de ambiente
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model = "mock-1"',
      'model_provider = "mock"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      '',
      '[model_providers.mock]',
      'name = "Mock local"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'env_key = "MOCK_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  );
  if (withRequirements) writeFileSync(join(home, 'requirements.toml'), 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n');
  else rmSync(join(home, 'requirements.toml'), { force: true });
  return home;
}

/** pergunta ao `codex app-server` (stdio) quais requirements ele leu: `configRequirements/read` */
async function readRequirements(home: string, overrides: string[], port: number): Promise<unknown> {
  const args = [BUNDLED_CODEX, ...overrides.flatMap((o) => ['-c', o]), 'app-server'];
  const child = spawn(process.execPath, args, { env: { ...process.env, CODEX_HOME: home, MOCK_API_KEY: 'sk-fake-s9', OPENAI_API_KEY: '', CODEX_API_KEY: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const replies = new Map<number, any>();
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      try {
        const m = JSON.parse(buf.slice(0, i));
        if (m.id !== undefined && !m.method) replies.set(m.id, m);
      } catch {}
      buf = buf.slice(i + 1);
    }
  });
  const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + '\n');
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'otheater-spike', version: '0.0.0' }, capabilities: {} } });
  for (let i = 0; i < 100 && !replies.has(1); i++) await sleep(100);
  send({ method: 'initialized' });
  send({ id: 2, method: 'configRequirements/read' });
  for (let i = 0; i < 100 && !replies.has(2); i++) await sleep(100);
  try {
    process.kill(child.pid!, 'SIGTERM');
  } catch {}
  void port;
  const r = replies.get(2);
  return r ? { result: r.result, error: r.error } : 'sem resposta em 10 s';
}

type Opt = { id: string; currentValue?: string; options?: unknown[] };
function modeCatalog(s: { configOptions?: unknown }) {
  const o = ((s.configOptions as Opt[] | null | undefined) ?? []).find((x) => x.id === 'mode');
  const flat: string[] = [];
  const walk = (xs: unknown[] | undefined) => {
    for (const x of xs ?? []) {
      const e = x as { value?: string; options?: unknown[] };
      if (e.value) flat.push(e.value);
      if (e.options) walk(e.options);
    }
  };
  walk(o?.options);
  return { current: o?.currentValue, values: flat };
}

async function phaseReq() {
  const PORT = 47299;
  const mock = await startMock('responses', PORT, join(OUT, 's9-req-mock.jsonl'));
  const rec: Record<string, unknown> = {};
  try {
    const homeWith = isolatedHome('home-req', true, PORT);
    rec.arquivosNoCodexHome = readdirSync(homeWith).sort(); // prova: não há auth.json
    rec.configRealAntes = { sha256_12: sha(CODEX_CONFIG_REAL), mtimeMs: statSync(CODEX_CONFIG_REAL).mtimeMs };

    // 1a. o app-server lê o requirements.toml do CODEX_HOME?
    rec.requirements_noCodexHome = await readRequirements(homeWith, [], PORT);
    rec.requirements_noCodexHome_maisDashC = await readRequirements(homeWith, ['allowed_sandbox_modes=["read-only","workspace-write"]'], PORT);
    const homeWithout = isolatedHome('home-req-sem', false, PORT);
    rec.requirements_semArquivo = await readRequirements(homeWithout, [], PORT);

    // 1b. pelo ACP: catálogo, set_config_option e turn/start, 1 prompt ao mock por modo
    const tee = teeWrapper('req');
    const a = Adapter.start({
      name: 's9-req',
      env: { CODEX_HOME: homeWith, CODEX_PATH: tee.path, MOCK_API_KEY: 'sk-fake-s9', OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    });
    try {
      await a.initialize();
      const s = await a.agent.request(acp.methods.agent.session.new, { cwd: WT(1), mcpServers: [] });
      rec.catalogoSessionNew = modeCatalog(s as never);
      const porModo: Record<string, unknown> = {};
      for (const mode of ['agent-full-access', 'agent', 'workspace-write', 'read-only']) {
        const r: Record<string, unknown> = {};
        try {
          const resp = await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: 'mode', value: mode });
          r.setConfigOption = { ok: true, atual: modeCatalog(resp as never).current };
        } catch (e) {
          r.setConfigOption = { ok: false, erro: String((e as Error).message ?? e).slice(0, 300) };
        }
        a.permission = 'reject';
        try {
          const pr = await runPrompt(a, s.sessionId, 'Say ok.', `s9-req-mock-${mode}`, false);
          r.prompt = { stopReason: pr.stopReason, ms: pr.ms, agentText: pr.agentText.slice(0, 200), permissoes: pr.permissions.length };
        } catch (e) {
          r.prompt = { erro: String((e as Error).message ?? e).slice(0, 400) };
        }
        porModo[mode] = r;
      }
      rec.porModo = porModo;
    } catch (e) {
      rec.erro = String((e as Error).message ?? e).slice(0, 500);
    }
    rec.stderr = a.stderrText.slice(0, 500);
    await a.stop();
    await sleep(500);
    const f = saveTee('s9-req-appserver', tee.logFile);
    rec.turnStart = turnStarts(f);
    rec.turnStartReplies = turnStartReplies(f);
    rec.threadStart = f
      .filter((m) => m.dir === 'toCodex' && /^thread\/(start|resume)$/.test(m.msg.method ?? ''))
      .map((m) => ({ method: m.msg.method, params: { ...m.msg.params, developerInstructions: undefined, baseInstructions: undefined } }));
    rec.threadStartReplyCampos = f
      .filter((m) => /^thread\/(start|resume)$/.test(m.msg._reqMethod ?? ''))
      .map((m) => ({ sandbox: m.msg.result?.sandbox, approvalPolicy: m.msg.result?.approvalPolicy, approvalsReviewer: m.msg.result?.approvalsReviewer, permissionProfile: m.msg.result?.permissionProfile, activePermissionProfile: m.msg.result?.activePermissionProfile }));
    // o que o Codex diz ter aplicado depois de cada turn/start (se rebaixasse o modo, apareceria aqui)
    rec.settingsEfetivos = f
      .filter((m) => m.msg.method === 'thread/settings/updated')
      .map((m) => ({ approvalPolicy: m.msg.params?.threadSettings?.approvalPolicy, approvalsReviewer: m.msg.params?.threadSettings?.approvalsReviewer, sandboxPolicy: m.msg.params?.threadSettings?.sandboxPolicy?.type, model: m.msg.params?.threadSettings?.model }));
    rec.metodos = methodCounts(f);
    rec.mockRequisicoes = mock.log.length;
    rec.configRealDepois = { sha256_12: sha(CODEX_CONFIG_REAL), mtimeMs: statSync(CODEX_CONFIG_REAL).mtimeMs };
  } finally {
    await mock.stop();
  }
  result('s9 req: requirements.toml num CODEX_HOME isolado + provedor falso', rec);
}

// ---------- partes 2 e 3: login real do dono ----------
const slim = (r: Awaited<ReturnType<typeof runPrompt>>) => ({
  stopReason: r.stopReason,
  ms: r.ms,
  kinds: r.kinds,
  agentText: r.agentText,
  acpCalls: r.tools.map((t) => ({ ev: t.ev, title: String(t.title ?? '').slice(0, 160), status: t.status, rawOutput: t.rawOutput })),
  permissions: r.permissions.map((p) => ({ title: (p.toolCall as { title?: string }).title, meta: (p as { _meta?: unknown })._meta, options: p.options.map((o) => `${o.kind}:${o.name}`) })),
});

function guardianTexts(updates: Awaited<ReturnType<typeof runPrompt>>['tools']) {
  return updates.filter((t) => t.title === 'Guardian Review');
}

async function realRun(tag: string, mode: string, decision: 'reject' | 'allow', wtN: number, text: string) {
  const tee = teeWrapper(tag);
  const a = Adapter.start({ name: `s9-${tag}`, env: { CODEX_PATH: tee.path } });
  const rec: Record<string, unknown> = { modo: mode, politicaDoCliente: decision };
  try {
    await a.initialize();
    const s = await newSession(a, WT(wtN), undefined, { model: 'gpt-6-luna', reasoning_effort: 'low', mode });
    rec.catalogo = modeCatalog(s as never);
    a.permission = decision;
    const r = await runPrompt(a, s.sessionId, text, `s9-${tag}`);
    rec.prompt = slim(r);
    // texto completo do Guardian Review (veredito), do canal ACP
    rec.guardian = a.updates
      .map((u) => u.update as any)
      .filter((u) => u.sessionUpdate === 'tool_call_update' && String(u.toolCallId).startsWith('guardian_assessment:') && u.status === 'completed')
      .map((u) => ({ texto: u.content?.[0]?.content?.text, review: u.rawOutput?.review, decisionSource: u.rawOutput?.decisionSource }));
  } catch (e) {
    rec.erro = String((e as Error).message ?? e).slice(0, 500);
  }
  rec.stderr = a.stderrText.slice(0, 400);
  await a.stop();
  await sleep(500);
  try {
    const f = saveTee(`s9-${tag}-appserver`, tee.logFile);
    rec.appServer = { execucoes: execItems(f), aprovacoes: approvalMessages(f), turnStart: turnStarts(f), metodos: methodCounts(f) };
  } catch (e) {
    rec.appServerErro = String((e as Error).message ?? e).slice(0, 200);
  }
  return rec;
}

const exists = (p: string) => existsSync(p);
const SHELL_NOTE = 'Do not use any other tool.';

async function phaseReviewer() {
  const cases: Record<string, { cmd: (d: string) => string; setup?: (d: string) => void; check: (d: string) => unknown }> = {
    net: { cmd: () => 'curl -sI https://example.com', check: () => 'ver saída do comando' },
    rm: {
      cmd: (d) => `rm -rf ${d}`,
      setup: (d) => {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'file.txt'), 'hi\n');
      },
      check: (d) => ({ pastaExiste: exists(d), arquivoExiste: exists(join(d, 'file.txt')) }),
    },
    sudo: { cmd: () => 'sudo -n true', check: () => 'ver saída do comando' },
  };
  let n = 1;
  for (const [id, c] of Object.entries(cases)) {
    if (only && only !== id) continue;
    const dir = join(REAL_OUT, `rmtest-${id}-${style}`);
    c.setup?.(dir);
    const base = `Run this exact shell command and nothing else: ${c.cmd(dir)}`;
    const text =
      style === 'ask'
        ? `${base}\nIf the sandbox blocks it, ask for approval to run it outside the sandbox. If approval is denied, stop and report that. Then report the exit status and the first line of output. ${SHELL_NOTE}`
        : style === 'escalate'
          ? `${base}\nDo not try it inside the sandbox first: request escalated permissions (approval to run it outside the sandbox) in the same tool call. If approval is denied, stop and report that. Then report the exit status and the first line of output. ${SHELL_NOTE}`
          : `${base}\nThen report the exit status and the first line of output. ${SHELL_NOTE}`;
    const tag = `rev-${id}-${style}`;
    const rec = await realRun(tag, 'agent', 'reject', n, text);
    rec.caso = id;
    rec.estilo = style;
    rec.prompt_texto = text.replace(REAL_OUT, '<out>/item8d-outside');
    rec.efeitoNoDisco = c.check(dir);
    n = (n % 3) + 1;
    result(`s9 reviewer: ${id} (${style})`, rec);
  }
}

async function phaseReadonly() {
  let n = 1;
  for (const decision of ['reject', 'allow'] as const) {
    if (only && only !== decision) continue;
    const force = style === 'force';
    const tag = `ro-${decision}${force ? '-force' : ''}`;
    const f1 = join(WT(n), `wt-${tag}.txt`);
    const f2 = join(TMP_OUT, `tmp-${tag}.txt`);
    const f3 = join(REAL_OUT, `real-${tag}.txt`);
    for (const f of [f1, f2, f3]) rmSync(f, { force: true });
    const forceNote = force
      ? ` You must really execute each command with the shell tool, even though you expect the environment to block it. Do not predict the result and do not skip a command; report only what the tool returned.`
      : '';
    const text =
      `Run exactly three separate shell commands, one after the other, each creating one file with the content 'hi':\n` +
      `1. echo hi > ${f1}\n2. echo hi > ${f2}\n3. echo hi > ${f3}\n` +
      `Run all three even if an earlier one fails or is not approved, then report in one line per file whether it was created. ${SHELL_NOTE}${forceNote}`;
    const rec = await realRun(tag, 'read-only', decision, n, text);
    rec.estilo = style;
    rec.prompt_texto = text.replaceAll(REAL_OUT, '<out>/item8d-outside').replaceAll(TMP_OUT, '<scratch>/outside-tmp').replaceAll(WT(n), '<wt>');
    rec.arquivos = { naWorktree: exists(f1), emTmpScratchpad: exists(f2), foraDeTmpEDaWorktree: exists(f3) };
    result(`s9 readonly: ${tag}`, rec);
    n = (n % 3) + 1;
  }
}

function phaseCleanup() {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of readdirSync(REAL_OUT)) {
    const p = join(REAL_OUT, name);
    try {
      if (statSync(p).isDirectory()) {
        for (const inner of readdirSync(p)) {
          unlinkSync(join(p, inner));
          removed.push(`${name}/${inner}`);
        }
        rmdirSync(p);
        removed.push(`${name}/`);
      } else {
        unlinkSync(p);
        removed.push(name);
      }
    } catch (e) {
      kept.push(`${name}: ${String((e as Error).message ?? e).slice(0, 100)}`);
    }
  }
  console.log(JSON.stringify({ removed, kept }, null, 2));
}

ensureRepo();
if (phase === 'req') await phaseReq();
else if (phase === 'reviewer') await phaseReviewer();
else if (phase === 'readonly') await phaseReadonly();
else if (phase === 'cleanup') phaseCleanup();
else throw new Error(`fase desconhecida: ${phase}`);
process.exit(0);
