import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, type ClientContext } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { Jsonl, countPrompt, now } from "./log.ts";
import { alive, tree } from "./proc.ts";
import { OUT } from "./paths.ts";
import { join } from "node:path";

export const ADAPTER_JS = join(import.meta.dirname, "..", "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");

export type Msg = any;
export type Seen = { t: number; msg: Msg };

export type PermDecision = { pick: "allow" | "reject" | "cancel" };

export class Harness {
  child!: ChildProcess;
  cx!: ClientContext;
  log: Jsonl;
  /** todas as mensagens do agente (a2c) */
  seen: Seen[] = [];
  permissions: Msg[] = [];
  permPolicy: (req: Msg) => PermDecision = () => ({ pick: "allow" });
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  closeConn!: () => void;

  name: string;
  constructor(name: string) {
    this.name = name;
    this.log = new Jsonl(name);
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  get pid() {
    return this.child.pid!;
  }

  /** Atualizacoes session/update de uma sessao, a partir do indice `from`. */
  updates(sessionId: string, from = 0) {
    return this.seen
      .slice(from)
      .filter((s) => s.msg.method === "session/update" && s.msg.params?.sessionId === sessionId)
      .map((s) => ({ t: s.t, update: s.msg.params.update as Msg, meta: s.msg.params._meta }));
  }

  rawSdkMessages(sessionId?: string) {
    return this.seen
      .filter((s) => s.msg.method === "_claude/sdkMessage" && (!sessionId || s.msg.params?.sessionId === sessionId))
      .map((s) => s.msg.params);
  }

  /** Envia session/prompt, mede o tempo ate o primeiro pedaco e resume os tipos de update. */
  async prompt(sessionId: string, text: string, opts: { tag: string; onFirstChunk?: () => void } = { tag: "?" }) {
    countPrompt(`${this.name}:${opts.tag}`);
    const from = this.seen.length;
    const sentAt = Date.now();
    const sentT = now();
    let firstChunkMs: number | null = null;
    const poll = setInterval(() => {
      if (firstChunkMs !== null) return;
      const u = this.updates(sessionId, from).find((x) =>
        ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(x.update.sessionUpdate),
      );
      if (u) {
        firstChunkMs = u.t - sentT; // t exato da mensagem recebida, relativo ao envio
        opts.onFirstChunk?.();
      }
    }, 20);
    this.log.write({ ev: "prompt_start", tag: opts.tag, sessionId, text });
    let resp: Msg;
    let err: unknown;
    try {
      resp = await this.cx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (e) {
      err = e;
    } finally {
      clearInterval(poll);
    }
    const ms = Date.now() - sentAt;
    const ups = this.updates(sessionId, from);
    const types: Record<string, number> = {};
    for (const u of ups) types[u.update.sessionUpdate] = (types[u.update.sessionUpdate] ?? 0) + 1;
    const textOut = ups
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk" && u.update.content?.type === "text")
      .map((u) => u.update.content.text)
      .join("");
    const summary = { tag: opts.tag, ms, firstChunkMs, stopReason: resp?.stopReason, usage: resp?.usage, types, error: err ? String((err as Error).message ?? err) : undefined };
    this.log.write({ ev: "prompt_end", ...summary, textOut: textOut.slice(0, 2000) });
    return { resp, err, ...summary, text: textOut, from };
  }
}

function toStream(h: Harness, child: ChildProcess): Stream {
  const base = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const readable = base.readable.pipeThrough(
    new TransformStream({
      transform(m, c) {
        h.seen.push({ t: now(), msg: m });
        h.log.write({ dir: "a2c", msg: m });
        c.enqueue(m);
      },
    }),
  );
  const w = base.writable.getWriter();
  const writable = new WritableStream({
    write(m) {
      h.log.write({ dir: "c2a", msg: m });
      return w.write(m);
    },
    close: () => w.close(),
  });
  return { readable, writable } as Stream;
}

export type SpawnOpts = {
  env?: Record<string, string | undefined>;
  agentLogs?: boolean;
  cwd?: string;
};

/**
 * Sobe o adaptador como subprocesso, liga o cliente ACP e roda `fn`. Ao fim, encerra o adaptador
 * e registra os descendentes que sobraram (orfaos).
 */
export async function withAdapter<T>(name: string, opts: SpawnOpts, fn: (h: Harness) => Promise<T>, endMode: "graceful" | "none" = "graceful"): Promise<T> {
  const h = new Harness(name);
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  // chave de API no ambiente venceria a assinatura (docs/08); o spike so usa a assinatura
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (opts.agentLogs !== false) env.CLAUDE_AGENT_LOGS = join(OUT, "agent-logs", name);
  h.child = spawn(process.execPath, [ADAPTER_JS], { env: env as NodeJS.ProcessEnv, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
  h.log.write({ ev: "spawn", pid: h.child.pid, node: process.version });
  h.child.stderr!.on("data", (d: Buffer) => h.log.write({ ev: "stderr", text: d.toString("utf8").slice(0, 4000) }));
  h.child.on("exit", (code, signal) => {
    h.log.write({ ev: "exit", code, signal });
    h.resolveExit({ code, signal });
  });
  const stream = toStream(h, h.child);
  const app = client({ name: "otheater-spike" })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const req = ctx.params as Msg;
      h.permissions.push(req);
      const d = h.permPolicy(req);
      const kinds = d.pick === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const opt = (req.options as Msg[]).find((o) => kinds.includes(o.kind));
      h.log.write({ ev: "permission_decision", want: d.pick, optionId: opt?.optionId, kind: opt?.kind });
      if (d.pick === "cancel" || !opt) return { outcome: { outcome: "cancelled" } } as Msg;
      return { outcome: { outcome: "selected", optionId: opt.optionId } } as Msg;
    })
    .onNotification("*", () => {});
  try {
    return await app.connectWith(stream, async (cx) => {
      h.cx = cx;
      return fn(h);
    });
  } catch (e) {
    // com endMode "none" o chamador mata o adaptador de proposito (kill -9): a conexao fechando e esperada
    if (endMode === "none" && /connection closed/i.test(String((e as Error)?.message ?? e))) return undefined as T;
    throw e;
  } finally {
    const before = h.child.pid && alive(h.child.pid) ? tree(h.child.pid) : [];
    if (endMode === "graceful" && alive(h.pid)) {
      h.child.kill("SIGTERM");
      await Promise.race([h.exited, new Promise((r) => setTimeout(r, 4000))]);
    }
    await new Promise((r) => setTimeout(r, 500));
    const leftovers = before.filter((p) => p.pid !== h.pid && alive(p.pid));
    h.log.write({ ev: "teardown", adapterAlive: alive(h.pid), leftovers: leftovers.map((p) => ({ pid: p.pid, comm: p.comm })) });
    for (const p of leftovers) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
    if (alive(h.pid)) h.child.kill("SIGKILL");
  }
}

/** Achata qualquer estrutura e devolve os objetos que tem `value` (opcoes de select). */
function collectValues(x: Msg, acc: { value: string; name?: string }[] = []) {
  if (Array.isArray(x)) x.forEach((i) => collectValues(i, acc));
  else if (x && typeof x === "object") {
    if (typeof x.value === "string" && "name" in x) acc.push({ value: x.value, name: x.name });
    for (const v of Object.values(x)) collectValues(v, acc);
  }
  return acc;
}

export function describeConfig(resp: Msg) {
  const opts = (resp.configOptions ?? []) as Msg[];
  return opts.map((o) => ({
    id: o.id,
    name: o.name,
    category: o.category,
    type: o.type,
    currentValue: o.currentValue,
    values: collectValues(o.options).map((v) => v.value),
  }));
}

/** Escolhe o modelo mais barato (Haiku, se houver) e esforco baixo; devolve o que foi aplicado. */
export async function pickCheap(h: Harness, sessionId: string, newResp: Msg) {
  const applied: Record<string, unknown> = {};
  for (const o of (newResp.configOptions ?? []) as Msg[]) {
    const vals = collectValues(o.options);
    let want: string | undefined;
    if (o.category === "model" || o.id === "model") want = vals.find((v) => /haiku/i.test(v.value + (v.name ?? "")))?.value;
    if (o.category === "thought_level" || o.id === "effort") want = vals.find((v) => /^low$/i.test(v.value))?.value ?? vals.find((v) => /low/i.test(v.value))?.value;
    if (want && want !== o.currentValue) {
      try {
        const r = await h.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: o.id, value: want } as Msg);
        applied[o.id] = { want, ok: true, resp: JSON.stringify(r).slice(0, 200) };
      } catch (e) {
        applied[o.id] = { want, ok: false, err: String((e as Error).message) };
      }
    } else if (want) applied[o.id] = { want, already: true };
    else applied[o.id] = { note: "sem opcao desejada", currentValue: o.currentValue };
  }
  h.log.write({ ev: "pickCheap", applied });
  return applied;
}

export const INIT_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: "otheater-spike", title: "OTheater spike", version: "0.0.0" },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
} as const;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
