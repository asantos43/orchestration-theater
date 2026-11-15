// Biblioteca do spike: sobe um adaptador ACP, registra cada mensagem em JSONL e mede o que chega.
import { tmpdir } from "node:os";
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk/unstable';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(HERE, 'out');
export const PROFILES = join(HERE, 'profiles'); // ignorado pelo git
export const SCRATCH =
  process.env.SPIKE_SCRATCH ?? join(tmpdir(), "otheater-spikes", "quota-exhaustion");
export const REPO = join(SCRATCH, 'repo');
export const WT = (n: number) => join(SCRATCH, `wt${n}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

export const PORTS = { claude: 47200, codex: 47210, opencode: 47220 } as const;
/** Chave FALSA, gerada a cada execução. Nunca é uma credencial real. */
export const FAKE_KEY = 'sk-fake-quota-spike-' + Math.random().toString(36).slice(2, 12);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Cria o repositório git de teste e as worktrees (idempotente). */
export function ensureRepo(n = 4) {
  mkdirSync(REPO, { recursive: true });
  try {
    readFileSync(join(REPO, '.git/HEAD'));
  } catch {
    sh('git', ['init', '-q', '-b', 'main'], REPO);
    writeFileSync(join(REPO, 'README.txt'), 'repositorio de teste do spike quota-exhaustion\n');
    sh('git', ['add', '.'], REPO);
    sh('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=teste', 'commit', '-q', '-m', 'init'], REPO);
  }
  for (let i = 1; i <= n; i++) {
    try {
      readFileSync(join(WT(i), 'README.txt'));
    } catch {
      sh('git', ['worktree', 'add', '-q', '-f', WT(i), '-b', `wt${i}-${Date.now()}`], REPO);
    }
  }
}

export class Jsonl {
  readonly t0 = performance.now();
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    writeFileSync(file, '');
  }
  now() {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }
  write(rec: Record<string, unknown>) {
    appendFileSync(this.file, JSON.stringify({ t: this.now(), ...rec }) + '\n');
  }
}

// ---------- processos ----------
export function descendants(root: number): { pid: number; comm: string }[] {
  const all = new Map<number, { pid: number; ppid: number; comm: string }>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      all.set(Number(d), { pid: Number(d), ppid: Number(stat.slice(rp + 2).split(' ')[1]), comm: stat.slice(stat.indexOf('(') + 1, rp) });
    } catch {}
  }
  const out: { pid: number; comm: string }[] = [];
  const walk = (pid: number) => {
    for (const p of all.values()) if (p.ppid === pid) (out.push({ pid: p.pid, comm: p.comm }), walk(p.pid));
  };
  walk(root);
  return out;
}
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- cliente ACP genérico ----------
export interface AdapterSpec {
  name: string;
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
}

export interface PromptOutcome {
  label: string;
  /** resposta ao `session/prompt` */
  stopReason?: string;
  error?: { code?: number; message?: string; data?: unknown };
  ms: number;
  /** tempo do 1º `session/update` e do 1º texto do agente, desde o envio */
  firstUpdateMs: number | null;
  firstTextMs: number | null;
  /** tempo do último `session/update` desde o envio */
  lastUpdateMs: number | null;
  timedOut: boolean;
  cancelLatencyMs?: number;
  updateKinds: Record<string, number>;
  agentText: string;
  /** erros/avisos que o adaptador mandou como texto do agente ou chamadas de ferramenta */
  toolCalls: { id: string; title?: string; status?: string }[];
  usageUpdates: unknown[];
  extNotifications: { method: string; params: unknown }[];
  /** `usage` e `_meta` da resposta do session/prompt */
  respUsage?: unknown;
  respMeta?: unknown;
  /** `session_info_update` recebidos (título e `_meta`, onde o codex-acp põe falhas tipadas) */
  infoUpdates: { t: number; title?: unknown; meta?: unknown }[];
  stderrDelta: string;
}

export class Adapter {
  readonly wire: Jsonl;
  readonly child: ChildProcess;
  conn!: acp.ClientConnection;
  exited: { code: number | null; signal: string | null; atMs: number } | null = null;
  stderrText = '';
  /** todas as notificações recebidas, com tempo */
  events: { at: number; method: string; params: any }[] = [];
  private listeners = new Set<(m: { at: number; method: string; params: any }) => void>();
  permissions: acp.RequestPermissionRequest[] = [];
  permissionPolicy: 'allow' | 'reject' = 'allow';

  readonly spec: AdapterSpec;
  private constructor(spec: AdapterSpec, child: ChildProcess, wire: Jsonl) {
    this.spec = spec;
    this.child = child;
    this.wire = wire;
  }
  get pid() {
    return this.child.pid!;
  }
  get agent() {
    return this.conn.agent;
  }

  static start(spec: AdapterSpec): Adapter {
    const wire = new Jsonl(join(OUT, `${spec.name}.jsonl`));
    const env = { ...process.env, ...spec.env } as NodeJS.ProcessEnv;
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const child = spawn(spec.cmd, spec.args, { env, cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const a = new Adapter(spec, child, wire);
    wire.write({ dir: 'proc', ev: 'spawn', pid: child.pid, cmd: spec.cmd, args: spec.args });
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      a.stderrText += s;
      wire.write({ dir: 'stderr', text: scrub(s).slice(0, 3000) });
    });
    child.on('exit', (code, signal) => {
      a.exited = { code, signal, atMs: wire.now() };
      wire.write({ dir: 'proc', ev: 'exit', code, signal });
    });
    const raw = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const stream: acp.Stream = {
      writable: new WritableStream({
        write(msg) {
          wire.write({ dir: 'c2a', msg });
          const w = raw.writable.getWriter();
          return w.write(msg).finally(() => w.releaseLock());
        },
      }),
      readable: raw.readable.pipeThrough(
        new TransformStream({
          transform(msg, ctl) {
            wire.write({ dir: 'a2c', msg: scrubObj(msg) });
            ctl.enqueue(msg);
          },
        }),
      ),
    };
    const app = acp
      .client({ name: 'otheater-spike' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const rec = { at: performance.now(), method: 'session/update', params: ctx.params };
        a.events.push(rec);
        for (const l of a.listeners) l(rec);
      })
      .onNotification('*', (ctx: any) => {
        // notificações fora do padrão (ex.: `_claude/...`)
        const m = String(ctx.method ?? '');
        if (m === 'session/update') return;
        const rec = { at: performance.now(), method: m, params: ctx.params };
        a.events.push(rec);
        for (const l of a.listeners) l(rec);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        a.permissions.push(ctx.params);
        const kinds = a.permissionPolicy === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
        const opt = ctx.params.options.find((o) => kinds.includes(o.kind));
        wire.write({ dir: 'policy', ev: 'permission', title: (ctx.params.toolCall as any)?.title, optionId: opt?.optionId });
        if (!opt) return { outcome: { outcome: 'cancelled' as const } };
        return { outcome: { outcome: 'selected' as const, optionId: opt.optionId } };
      });
    a.conn = app.connect(stream);
    return a;
  }

  async initialize(clientCapabilities: Record<string, unknown> = {}) {
    return this.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: { name: 'otheater-spike', title: 'OTheater spike', version: '0.0.0' },
    });
  }

  async newSession(cwd: string) {
    return this.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  }
  async loadSession(sessionId: string, cwd: string) {
    return this.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
  }
  async setOption(sessionId: string, configId: string, value: string) {
    return this.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
  }

  /**
   * Envia um prompt e mede tudo o que chega. Se passar de `timeoutMs`, manda `session/cancel` e anota.
   * `sessionUpdates` só inclui os `session/update` da sessão pedida.
   */
  async prompt(sessionId: string, text: string, label: string, timeoutMs = 120_000): Promise<PromptOutcome> {
    const t0 = performance.now();
    const startIdx = this.events.length;
    const stderrBefore = this.stderrText.length;
    let timedOut = false;
    let cancelAt = 0;
    this.wire.write({ ev: 'prompt_start', label, sessionId, text });
    const timer = setTimeout(() => {
      timedOut = true;
      cancelAt = performance.now();
      this.wire.write({ ev: 'timeout_cancel', label });
      void this.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    }, timeoutMs);
    let resp: any;
    let error: PromptOutcome['error'];
    let tEnd = 0;
    try {
      resp = await this.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
    } catch (e: any) {
      error = { code: e?.code, message: String(e?.message ?? e), data: e?.data };
    } finally {
      clearTimeout(timer);
      tEnd = performance.now();
    }
    const ev = this.events.slice(startIdx).filter((e) => e.method !== 'session/update' || e.params?.sessionId === sessionId);
    const ups = ev.filter((e) => e.method === 'session/update');
    const kinds: Record<string, number> = {};
    let agentText = '';
    let firstUpdateMs: number | null = null;
    let firstTextMs: number | null = null;
    let lastUpdateMs: number | null = null;
    const toolCalls: PromptOutcome['toolCalls'] = [];
    const usageUpdates: unknown[] = [];
    const infoUpdates: PromptOutcome['infoUpdates'] = [];
    for (const e of ups) {
      const u = e.params.update;
      const k = u.sessionUpdate as string;
      kinds[k] = (kinds[k] ?? 0) + 1;
      const rel = Math.round(e.at - t0);
      firstUpdateMs ??= rel;
      lastUpdateMs = rel;
      if (k === 'agent_message_chunk' && u.content?.type === 'text') {
        firstTextMs ??= rel;
        agentText += u.content.text;
      }
      if (k === 'tool_call') toolCalls.push({ id: String(u.toolCallId), title: u.title, status: u.status });
      if (k === 'tool_call_update') {
        const t = toolCalls.find((x) => x.id === String(u.toolCallId));
        if (t && u.status) t.status = u.status;
      }
      if (k === 'session_info_update') infoUpdates.push({ t: rel, title: u.title, meta: scrubObj(u._meta ?? e.params._meta) });
      if (k === 'usage_update') usageUpdates.push({ t: rel, update: scrubObj(u), meta: scrubObj(e.params._meta) });
    }
    const out: PromptOutcome = {
      label,
      stopReason: resp?.stopReason,
      error,
      ms: Math.round(tEnd - t0),
      firstUpdateMs,
      firstTextMs,
      lastUpdateMs,
      timedOut,
      cancelLatencyMs: timedOut ? Math.round(tEnd - cancelAt) : undefined,
      updateKinds: kinds,
      agentText,
      toolCalls,
      usageUpdates,
      respUsage: scrubObj(resp?.usage),
      respMeta: scrubObj(resp?._meta),
      infoUpdates,
      extNotifications: ev.filter((e) => e.method !== 'session/update').map((e) => ({ method: e.method, params: scrubObj(e.params) })),
      stderrDelta: scrub(this.stderrText.slice(stderrBefore)).slice(0, 1500),
    };
    this.wire.write({ ev: 'prompt_end', ...out, agentText: out.agentText.slice(0, 600), usageUpdates: undefined });
    return out;
  }

  /** replay produzido por session/load: o que chegou entre `from` e agora */
  replaySince(from: number, sessionId: string) {
    const ups = this.events.slice(from).filter((e) => e.method === 'session/update' && e.params?.sessionId === sessionId);
    const kinds: Record<string, number> = {};
    let user = '';
    let agent = '';
    let thought = '';
    const tools: string[] = [];
    for (const e of ups) {
      const u = e.params.update;
      kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
      if (u.sessionUpdate === 'user_message_chunk' && u.content?.type === 'text') user += u.content.text;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') agent += u.content.text;
      if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') thought += u.content.text;
      if (u.sessionUpdate === 'tool_call') tools.push(`${u.title ?? '?'}:${u.status ?? '?'}`);
    }
    return { kinds, userText: user, agentText: agent, thoughtChars: thought.length, tools };
  }

  /** mata a árvore inteira (só processos que este spike iniciou) */
  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const kids = descendants(this.pid).map((p) => p.pid);
    try {
      this.conn.close();
    } catch {}
    try {
      this.child.kill(signal);
    } catch {}
    for (const k of kids) {
      try {
        process.kill(k, signal);
      } catch {}
    }
    for (let i = 0; i < 40 && !this.exited; i++) await sleep(100);
    for (const k of [this.pid, ...kids]) if (alive(k)) { try { process.kill(k, 'SIGKILL'); } catch {} }
  }
}

/** remove qualquer coisa que pareça credencial de um texto antes de gravar */
export function scrub(s: string): string {
  return s
    .replace(/(authorization|x-api-key|api[_-]?key|bearer|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[omitido]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[omitido]')
    .replace(/\/home\/anderson/g, '~');
}
export function scrubObj<T>(o: T): T {
  const walk = (v: any, key = ''): any => {
    if (typeof v === 'string') return /^(authorization|x-api-key|api-?key|access_token|refresh_token|token)$/i.test(key) ? '[omitido]' : scrub(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(o);
}

export function result(file: string, name: string, data: unknown) {
  appendFileSync(join(OUT, file), JSON.stringify({ t: new Date().toISOString(), name, data }) + '\n');
  console.log(`\n=== ${name} ===\n` + JSON.stringify(data, null, 2));
}

export function configOptionValues(resp: any, id: string): string[] {
  const o = (resp?.configOptions ?? []).find((x: any) => x.id === id);
  const vals: string[] = [];
  const walk = (x: any) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (typeof x.value === 'string') vals.push(x.value);
      for (const v of Object.values(x)) if (typeof v === 'object') walk(v);
    }
  };
  walk(o?.options);
  return vals;
}

/** resumo do log do mock por requisição principal: intervalos e contagem */
export function summarizeMock(log: import('./mock.ts').LogEntry[], sinceMs = 0) {
  const rows = log.filter((l) => l.tMs >= sinceMs);
  const main = rows.filter((l) => l.main);
  const gaps = main.slice(1).map((l, i) => l.tMs - main[i]!.tMs);
  return {
    total: rows.length,
    main: main.length,
    aux: rows.filter((l) => !l.main && l.action.startsWith('aux')).length,
    other: rows.filter((l) => !l.main && !l.action.startsWith('aux')).length,
    mainActions: main.map((l) => l.action.replace(/^main#\d+:/, '')).join(','),
    firstMainAtMs: main[0] ? main[0].tMs - sinceMs : null,
    gapsMs: gaps,
    lastMainAtMs: main.length ? main[main.length - 1]!.tMs - sinceMs : null,
    retryCounts: main.map((l) => l.retryCount).join(','),
    stream: main.map((l) => (l.stream === null ? '-' : l.stream ? 's' : 'n')).join(''),
    paths: [...new Set(rows.map((l) => l.path))],
  };
}

/** Ambiente do processo atual sem nenhuma variável de cliente/provedor: o perfil de teste entra só pelo que o cenário define. */
export function cleanEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|OPENAI|CODEX|OPENCODE|AI_AGENT|XDG_)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
