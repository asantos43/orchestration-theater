// Biblioteca do spike: sobe o codex-acp, registra cada mensagem em JSONL e mede processos/RSS.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(HERE, 'out');
export const SCRATCH =
  '/tmp/claude-1000/-home-anderson-Dev-AI-projetos-github-orchestration-theater/7fae85d3-3bfb-4d0b-aaf1-48870b56d0b2/scratchpad/acp-codex';
export const REPO = join(SCRATCH, 'repo');
export const WT = (n: number) => join(SCRATCH, `wt${n}`);
export const ADAPTER_JS = join(HERE, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js');
export const BUNDLED_CODEX = join(HERE, 'node_modules/@openai/codex/bin/codex.js');

mkdirSync(OUT, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();

export function jsonl(file: string) {
  const path = join(OUT, file);
  return (obj: Record<string, unknown>) => appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ...obj }) + '\n');
}

// ---------- medição de processos ----------
export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  rssKB: number;
}

function readProc(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, rp);
    const rest = stat.slice(rp + 2).split(' ');
    const ppid = Number(rest[1]);
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)/.exec(status);
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    return { pid, ppid, comm, cmd, rssKB: m ? Number(m[1]) : 0 };
  } catch {
    return null;
  }
}

export function allProcs(): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const p = readProc(Number(d));
    if (p) list.push(p);
  }
  return list;
}

export function tree(rootPid: number, procs = allProcs()): ProcInfo[] {
  const kids = new Map<number, ProcInfo[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: ProcInfo[] = [];
  const walk = (pid: number) => {
    const me = procs.find((p) => p.pid === pid);
    if (me) out.push(me);
    for (const k of kids.get(pid) ?? []) walk(k.pid);
  };
  walk(rootPid);
  return out;
}

export function summarizeTree(rootPid: number) {
  const t = tree(rootPid);
  const byComm: Record<string, { n: number; rssMB: number }> = {};
  for (const p of t) {
    const k = p.comm;
    byComm[k] ??= { n: 0, rssMB: 0 };
    byComm[k].n++;
    byComm[k].rssMB += p.rssKB / 1024;
  }
  for (const k of Object.keys(byComm)) byComm[k]!.rssMB = Math.round(byComm[k]!.rssMB * 10) / 10;
  return {
    count: t.length,
    rssMB: Math.round((t.reduce((a, p) => a + p.rssKB, 0) / 1024) * 10) / 10,
    byComm,
    procs: t.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, rssMB: Math.round(p.rssKB / 102.4) / 10, cmd: p.cmd.slice(0, 160) })),
  };
}

// ---------- adaptador ----------
export type PermissionDecision = 'allow' | 'reject' | 'cancel' | ((req: acp.RequestPermissionRequest) => string | 'cancel');

export interface StartOpts {
  name: string;
  env?: Record<string, string>;
  /** usa o `codex` do PATH (0.169.0) em vez do empacotado (0.166.0) */
  pathCodex?: boolean;
  extraArgs?: string[];
}

export class Adapter {
  readonly log: ReturnType<typeof jsonl>;
  readonly updates: { at: number; sessionId: string; update: acp.SessionUpdate }[] = [];
  readonly permissions: acp.RequestPermissionRequest[] = [];
  permission: PermissionDecision = 'reject';
  stderrText = '';
  exited: { code: number | null; signal: string | null; at: number } | null = null;
  onUpdate: ((u: { at: number; sessionId: string; update: acp.SessionUpdate }) => void) | null = null;
  conn!: acp.ClientConnection;

  readonly name: string;
  readonly child: ChildProcess;
  private constructor(name: string, child: ChildProcess, log: ReturnType<typeof jsonl>) {
    this.name = name;
    this.child = child;
    this.log = log;
  }

  get pid() {
    return this.child.pid!;
  }
  get agent() {
    return this.conn.agent;
  }

  static start(opts: StartOpts): Adapter {
    const log = jsonl(`${opts.name}.jsonl`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...opts.env };
    if (!opts.pathCodex) env.CODEX_PATH = BUNDLED_CODEX;
    const child = spawn(process.execPath, [ADAPTER_JS, ...(opts.extraArgs ?? [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const a = new Adapter(opts.name, child, log);
    log({ dir: 'meta', event: 'spawn', pid: child.pid, codexPath: env.CODEX_PATH ?? 'PATH', codexHome: env.CODEX_HOME ?? '(padrao)' });
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      a.stderrText += s;
      log({ dir: 'stderr', text: s.slice(0, 2000) });
    });
    child.on('exit', (code, signal) => {
      a.exited = { code, signal, at: now() };
      log({ dir: 'meta', event: 'exit', code, signal });
    });

    const base = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    // tap: registra cada mensagem trocada
    const stream: acp.Stream = {
      readable: base.readable.pipeThrough(
        new TransformStream({
          transform(msg, ctl) {
            log({ dir: 'in', msg });
            ctl.enqueue(msg);
          },
        }),
      ),
      writable: (() => {
        const t = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
          transform(msg, ctl) {
            log({ dir: 'out', msg });
            ctl.enqueue(msg);
          },
        });
        void t.readable.pipeTo(base.writable).catch(() => {});
        return t.writable;
      })(),
    };

    const app = acp
      .client({ name: 'otheater-spike' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const rec = { at: now(), sessionId: params.sessionId, update: params.update };
        a.updates.push(rec);
        a.onUpdate?.(rec);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        a.permissions.push(params);
        const d = a.permission;
        if (d === 'cancel') return { outcome: { outcome: 'cancelled' as const } };
        let optionId: string | undefined;
        if (typeof d === 'function') {
          const r = d(params);
          if (r === 'cancel') return { outcome: { outcome: 'cancelled' as const } };
          optionId = r;
        } else {
          const kinds = d === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
          optionId = params.options.find((o) => kinds.includes(o.kind))?.optionId;
        }
        if (!optionId) return { outcome: { outcome: 'cancelled' as const } };
        log({ dir: 'meta', event: 'permission_decision', optionId });
        return { outcome: { outcome: 'selected' as const, optionId } };
      });
    a.conn = app.connect(stream);
    return a;
  }

  async initialize() {
    return this.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'otheater-spike', title: 'OTheater spike', version: '0.0.0' },
    });
  }

  /** mata a árvore inteira do adaptador */
  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const pids = tree(this.pid).map((p) => p.pid);
    try {
      this.conn.close();
    } catch {}
    for (const p of pids.reverse()) {
      try {
        process.kill(p, signal);
      } catch {}
    }
    for (let i = 0; i < 50 && !this.exited; i++) await sleep(100);
    if (!this.exited) {
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {}
      }
    }
  }
}

export function textOf(update: acp.SessionUpdate): string {
  const u = update as { content?: { type?: string; text?: string } };
  return u.content?.type === 'text' ? (u.content.text ?? '') : '';
}

/** resume os tipos de session/update recebidos */
export function updateKinds(updates: { update: acp.SessionUpdate }[]) {
  const c: Record<string, number> = {};
  for (const u of updates) c[(u.update as { sessionUpdate: string }).sessionUpdate] = (c[(u.update as { sessionUpdate: string }).sessionUpdate] ?? 0) + 1;
  return c;
}

export function fileSize(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export function result(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify({ t: new Date().toISOString(), name, data }) + '\n');
  console.log(`\n=== ${name} ===\n` + JSON.stringify(data, null, 2));
}

export const PROMPTS_FILE = join(OUT, 'prompts-count.jsonl');
/** contabiliza cada session/prompt enviado (limite do dono: 25) */
export function countPrompt(label: string, model = true) {
  appendFileSync(PROMPTS_FILE, JSON.stringify({ t: new Date().toISOString(), label, model }) + '\n');
}
export function promptsSpent(): number {
  try {
    return readFileSync(PROMPTS_FILE, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ---------- utilitários de cenário ----------
export async function newSession(a: Adapter, cwd: string, mcpUrl?: string, config: Record<string, string> = { model: 'gpt-6-luna', reasoning_effort: 'low', mode: 'workspace-write' }) {
  const s = await a.agent.request(acp.methods.agent.session.new, {
    cwd,
    mcpServers: mcpUrl ? [{ type: 'http', name: 'spike', url: mcpUrl, headers: [] }] : [],
  });
  for (const [configId, value] of Object.entries(config)) {
    await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId, value });
  }
  return s;
}

export async function runPrompt(a: Adapter, sid: string, text: string, label: string, model = true) {
  countPrompt(label, model);
  a.updates.length = 0;
  a.permissions.length = 0;
  const t0 = now();
  const resp = await a.agent.request(acp.methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: 'text', text }] });
  const ms = now() - t0;
  const kinds = updateKinds(a.updates);
  const agentText = a.updates.map((u) => ((u.update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk' ? textOf(u.update) : '')).join('');
  const tools = a.updates
    .filter((u) => ['tool_call', 'tool_call_update'].includes((u.update as { sessionUpdate: string }).sessionUpdate))
    .map((u) => u.update as unknown as Record<string, unknown>)
    .map((u) => ({ ev: u.sessionUpdate, id: String(u.toolCallId).slice(0, 14), title: u.title, kind: u.kind, status: u.status, rawInput: u.rawInput, rawOutput: JSON.stringify(u.rawOutput)?.slice(0, 300) }));
  return { stopReason: resp.stopReason, ms, kinds, agentText: agentText.slice(0, 600), tools, permissions: [...a.permissions], usage: (resp as { usage?: unknown }).usage, resp };
}

export function codexSessionFiles(sid: string) {
  const home = process.env.HOME!;
  const out: { p: string; bytes: number | null }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(sid)) out.push({ p, bytes: fileSize(p) });
    }
  };
  try {
    walk(join(home, '.codex/sessions'));
  } catch {}
  return out;
}
