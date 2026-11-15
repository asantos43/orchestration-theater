import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { spendPrompt } from './budget.ts';
import { Jsonl } from './jsonl.ts';
import { OUT } from './paths.ts';
import { join } from 'node:path';

type Perm = acp.RequestPermissionRequest;
export type PermissionPolicy = (req: Perm) => acp.RequestPermissionResponse;

export type Agent = Awaited<ReturnType<typeof startAgent>>;

export type PromptResult = {
  label: string;
  response: acp.PromptResponse | { error: unknown };
  stopReason?: string;
  ms: number;
  firstUpdateMs: number | null;
  firstTextChunkMs: number | null;
  updateCounts: Record<string, number>;
  text: string;
  toolCalls: { id: string; title?: string; kind?: string; status?: string; name?: string; name0?: string }[];
  permissionRequests: Perm[];
  usage: unknown;
};

/**
 * Sobe `opencode acp` como subprocesso e liga um cliente ACP. Toda mensagem JSON-RPC
 * trocada (nos dois sentidos) vai para out/<name>.jsonl.
 */
export async function startAgent(opts: {
  name: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  args?: string[];
  permission?: PermissionPolicy;
  log?: boolean;
}) {
  const wire = new Jsonl(join(OUT, `${opts.name}.jsonl`));
  const child: ChildProcess = spawn('opencode', ['acp', ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const errLog = createWriteStream(join(OUT, `${opts.name}.stderr.log`));
  child.stderr!.pipe(errLog);
  let exit: { code: number | null; signal: string | null; atMs: number } | null = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal, atMs: wire.now() };
    wire.write({ dir: 'proc', ev: 'exit', code, signal });
  });
  wire.write({ dir: 'proc', ev: 'spawn', pid: child.pid, cwd: opts.cwd, args: ['acp', ...(opts.args ?? [])] });

  const raw = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  // espelho do tráfego: loga cada mensagem antes de entregar
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
          wire.write({ dir: 'a2c', msg });
          ctl.enqueue(msg);
        },
      }),
    ),
  };

  const listeners = new Set<(n: acp.SessionNotification) => void>();
  const permLog: Perm[] = [];
  const app = acp
    .client({ name: 'otheater-spike' })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      for (const l of listeners) l(ctx.params);
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      permLog.push(ctx.params);
      const policy = opts.permission;
      if (!policy) return { outcome: { outcome: 'cancelled' } };
      const r = policy(ctx.params);
      wire.write({ dir: 'policy', ev: 'permission_answer', answer: r });
      return r;
    });
  const conn = app.connect(stream);
  const a = conn.agent;

  async function prompt(sessionId: string, text: string, label: string): Promise<PromptResult> {
    const n = spendPrompt(label, text);
    wire.write({ dir: 'meta', ev: 'prompt_start', n, label });
    const t0 = performance.now();
    const res: PromptResult = {
      label, response: { error: 'pendente' }, ms: 0, firstUpdateMs: null, firstTextChunkMs: null,
      updateCounts: {}, text: '', toolCalls: [], permissionRequests: [], usage: null,
    };
    const permBefore = permLog.length;
    const l = (n: acp.SessionNotification) => {
      if (n.sessionId !== sessionId) return;
      const u = n.update as Record<string, any>;
      const kind = u.sessionUpdate as string;
      const now = performance.now() - t0;
      res.firstUpdateMs ??= now;
      res.updateCounts[kind] = (res.updateCounts[kind] ?? 0) + 1;
      if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
        res.firstTextChunkMs ??= now;
        res.text += u.content.text;
      }
      if (kind === 'tool_call') res.toolCalls.push({ id: u.toolCallId, title: u.title, name0: u.title, kind: u.kind, status: u.status });
      if (kind === 'tool_call_update') {
        const t = res.toolCalls.find((x) => x.id === u.toolCallId);
        if (t && u.status) t.status = u.status;
        if (t && u.title) t.title = u.title;
      }
      if (kind === 'usage_update') res.usage = u;
    };
    listeners.add(l);
    try {
      const r = await a.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      res.response = r;
      res.stopReason = r.stopReason;
      if ((r as any).usage) res.usage = (r as any).usage;
    } catch (e) {
      res.response = { error: e };
      res.stopReason = 'ERROR';
    } finally {
      listeners.delete(l);
    }
    res.ms = Math.round(performance.now() - t0);
    res.permissionRequests = permLog.slice(permBefore);
    wire.write({ dir: 'meta', ev: 'prompt_end', n, label, stopReason: res.stopReason, ms: res.ms });
    return res;
  }

  return {
    child, wire, conn, a, listeners, prompt,
    get pid() { return child.pid!; },
    get exit() { return exit; },
    async close() {
      conn.close();
      child.stdin?.end();
      child.kill('SIGTERM');
      await new Promise<void>((r) => { if (exit) r(); else child.once('exit', () => r()); setTimeout(r, 3000); });
    },
  };
}

export function ms(since: number): number {
  return Math.round(performance.now() - since);
}
