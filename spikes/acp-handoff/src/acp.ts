// Cliente ACP generico para os tres clientes (claude, codex, opencode) + captura de trajetoria.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { OUT } from "./task.ts";

export type ClientName = "claude" | "codex" | "opencode";
type Msg = any;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIB = join(import.meta.dirname, "..", "..");

export const SPEC: Record<ClientName, { cmd: string; args: string[]; model: string; effort: string; mode?: string }> = {
  claude: { cmd: process.execPath, args: [join(SIB, "acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")], model: "haiku", effort: "low" },
  codex: { cmd: process.execPath, args: [join(SIB, "acp-codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js")], model: "gpt-6-luna", effort: "low", mode: "workspace-write" },
  opencode: { cmd: "opencode", args: ["acp"], model: process.env.OT_MODEL ?? "google/gemini-3.1-flash-lite", effort: "low" },
};

// ---- processos (so descendentes do que eu mesmo iniciei) ----
function ppidOf(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}
export function descendants(root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const pp = ppidOf(Number(d));
    if (pp !== null) kids.set(pp, [...(kids.get(pp) ?? []), Number(d)]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    out.push(p);
    for (const k of kids.get(p) ?? []) walk(k);
  };
  walk(root);
  return out;
}
export function killTree(root: number) {
  const pids = descendants(root);
  for (const p of pids.reverse()) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  return pids.length;
}

// ---- trajetoria capturada pelo cliente ----
export type ToolRec = {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: string[];
  input?: string;
  cmd?: string;
  output?: string;
  t0: number;
  t1?: number;
};
export type Trace = {
  tools: ToolRec[];
  messages: string[];
  thoughts: number;
  updates: number;
  /** indices de tools concluidas, na ordem */
  completed: string[];
};
const clip = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};
function contentText(c: Msg): string {
  if (!c) return "";
  const arr = Array.isArray(c) ? c : [c];
  return arr
    .map((x) => x?.content?.text ?? x?.text ?? (x?.type === "diff" ? `diff ${x.path}` : ""))
    .filter(Boolean)
    .join("\n");
}

export type PromptOut = {
  stopReason?: string;
  error?: string;
  killed: boolean;
  ms: number;
  usage?: Msg;
  trace: Trace;
  text: string;
};

export class AcpRun {
  child!: ChildProcess;
  cx!: any;
  name: string;
  clientName: ClientName;
  wire: string;
  trace: Trace = { tools: [], messages: [], thoughts: 0, updates: 0, completed: [] };
  private curMsg = "";
  private listeners = new Set<(u: Msg, sid: string) => void>();
  perms = 0;
  closeConn!: () => void;
  started = Date.now();
  initResp: Msg;

  constructor(clientName: ClientName, name: string) {
    this.clientName = clientName;
    this.name = name;
    this.wire = join(OUT, `${name}.wire.jsonl`);
    writeFileSync(this.wire, "");
  }
  get pid() {
    return this.child.pid!;
  }
  private w(rec: Msg) {
    appendFileSync(this.wire, JSON.stringify({ t: Date.now() - this.started, ...rec }) + "\n");
  }

  async start(cwd: string, env: Record<string, string | undefined> = {}) {
    const sp = SPEC[this.clientName];
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    if (this.clientName === "claude") {
      delete e.ANTHROPIC_API_KEY;
      delete e.ANTHROPIC_AUTH_TOKEN;
    }
    this.child = spawn(sp.cmd, sp.args, { cwd, env: e as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.on("data", (d: Buffer) => this.w({ dir: "stderr", text: d.toString().slice(0, 1500) }));
    this.child.on("exit", (code, signal) => this.w({ dir: "proc", ev: "exit", code, signal }));
    this.w({ dir: "proc", ev: "spawn", pid: this.child.pid, client: this.clientName });
    const base = ndJsonStream(Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>);
    const w = base.writable.getWriter();
    const stream = {
      readable: base.readable.pipeThrough(
        new TransformStream({
          transform: (m, c) => {
            this.w({ dir: "a2c", msg: m });
            c.enqueue(m);
          },
        }),
      ),
      writable: new WritableStream({
        write: (m) => {
          this.w({ dir: "c2a", msg: m });
          return w.write(m);
        },
      }),
    } as Stream;
    const app = client({ name: "otheater-spike" })
      .onRequest(methods.client.session.requestPermission, (ctx: any) => {
        this.perms++;
        const req = ctx.params as Msg;
        const opt = (req.options as Msg[]).find((o) => o.kind === "allow_once") ?? (req.options as Msg[]).find((o) => o.kind === "allow_always");
        this.w({ dir: "policy", ev: "permission", title: req.toolCall?.title, picked: opt?.optionId });
        return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
      })
      .onNotification(methods.client.session.update, (ctx: any) => this.onUpdate(ctx.params));
    this.cx = (app as any).connect(stream).agent;
    this.initResp = await this.cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: "otheater-spike", title: "OTheater spike", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    return this.initResp;
  }

  private onUpdate(p: Msg) {
    const u = p.update as Msg;
    const kind = u.sessionUpdate as string;
    const t = Date.now() - this.started;
    this.trace.updates++;
    if (kind === "agent_message_chunk" && u.content?.type === "text") this.curMsg += u.content.text;
    else if (this.curMsg && kind !== "usage_update" && kind !== "available_commands_update" && kind !== "session_info_update") {
      this.trace.messages.push(this.curMsg);
      this.curMsg = "";
    }
    if (kind === "agent_thought_chunk") this.trace.thoughts++;
    if (kind === "tool_call" || kind === "tool_call_update") {
      let r = this.trace.tools.find((x) => x.id === u.toolCallId);
      if (!r) {
        r = { id: u.toolCallId, t0: t };
        this.trace.tools.push(r);
      }
      if (u.title) r.title = u.title;
      if (u.kind) r.kind = u.kind;
      const locs = [...(u.locations ?? []).map((l: Msg) => l.path), ...(Array.isArray(u.content) ? u.content.filter((x: Msg) => x?.type === "diff" && x.path).map((x: Msg) => x.path) : [])];
      if (locs.length) r.locations = [...new Set([...(r.locations ?? []), ...locs])];
      if (u.rawInput) {
        r.input = clip(u.rawInput, 400);
        const c = u.rawInput.command ?? u.rawInput.cmd;
        if (c) r.cmd = Array.isArray(c) ? c.join(" ") : String(c);
      }
      const out = u.rawOutput ? clip(u.rawOutput, 500) : contentText(u.content);
      if (out) r.output = clip(out, 500);
      if (u.status) {
        const was = r.status;
        r.status = u.status;
        if ((u.status === "completed" || u.status === "failed") && was !== u.status) {
          r.t1 = t;
          this.trace.completed.push(r.id);
        }
      }
    }
    for (const l of this.listeners) l(u, p.sessionId);
  }

  flushMsg() {
    if (this.curMsg) {
      this.trace.messages.push(this.curMsg);
      this.curMsg = "";
    }
  }

  async newSession(cwd: string) {
    const params: Msg = { cwd, mcpServers: [] };
    // claude: sem conectores/MCP do perfil do dono dentro da sessao de teste
    if (this.clientName === "claude") params._meta = { claudeCode: { options: { strictMcpConfig: true } } };
    const r = await this.cx.request(methods.agent.session.new, params);
    await this.cheap(r.sessionId, r);
    return r.sessionId as string;
  }

  async load(sessionId: string, cwd: string) {
    const params: Msg = { sessionId, cwd, mcpServers: [] };
    if (this.clientName === "claude") params._meta = { claudeCode: { options: { strictMcpConfig: true } } };
    const t = Date.now();
    const before = this.trace.updates;
    const r = await this.cx.request(methods.agent.session.load, params);
    const ms = Date.now() - t;
    await this.cheap(sessionId, r);
    return { ms, replayed: this.trace.updates - before };
  }

  private async cheap(sessionId: string, resp: Msg) {
    const sp = SPEC[this.clientName];
    const applied: Record<string, unknown> = {};
    const set = async (id: string, value: string) => {
      try {
        await this.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: id, value });
        applied[id] = value;
      } catch (e) {
        applied[id] = `ERR ${(e as Error).message}`;
      }
    };
    const opts = (resp.configOptions ?? []) as Msg[];
    const values = (o: Msg) => JSON.stringify(o.options ?? []);
    for (const o of opts) {
      if (o.id === "model" && o.currentValue !== sp.model) {
        const hit = this.clientName === "claude" ? "haiku" : sp.model;
        if (values(o).includes(`"${hit}"`) || values(o).toLowerCase().includes(hit)) await set("model", hit);
      }
      if ((o.id === "effort" || o.id === "reasoning_effort") && o.currentValue !== sp.effort && values(o).includes(`"${sp.effort}"`)) await set(o.id, sp.effort);
      if (o.id === "mode" && sp.mode && o.currentValue !== sp.mode && values(o).includes(`"${sp.mode}"`)) await set("mode", sp.mode);
    }
    this.w({ dir: "meta", ev: "cheap", applied, current: opts.map((o) => [o.id, o.currentValue]) });
    return applied;
  }

  /**
   * Envia um prompt. `stopWhen` e avaliado a cada atualizacao; se devolver verdadeiro, o adaptador
   * (e a arvore de processos dele) recebe SIGKILL e o prompt termina como `killed`.
   */
  async prompt(sessionId: string, text: string, stopWhen?: (t: Trace) => boolean): Promise<PromptOut> {
    const from = { tools: this.trace.tools.length, msgs: this.trace.messages.length, completed: this.trace.completed.length, thoughts: this.trace.thoughts, upd: this.trace.updates };
    const t0 = Date.now();
    let killed = false;
    let l: ((u: Msg, sid: string) => void) | undefined;
    if (stopWhen) {
      l = (_u, sid) => {
        if (killed || sid !== sessionId) return;
        if (stopWhen(this.trace)) {
          killed = true;
          const n = killTree(this.pid);
          this.w({ dir: "meta", ev: "KILL", killedProcs: n, completedTools: this.trace.completed.length });
        }
      };
      this.listeners.add(l);
    }
    this.w({ dir: "meta", ev: "prompt_start", chars: text.length });
    let resp: Msg;
    let error: string | undefined;
    try {
      resp = await this.cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    } catch (e) {
      error = String((e as Error).message ?? e);
    } finally {
      if (l) this.listeners.delete(l);
    }
    this.flushMsg();
    const ms = Date.now() - t0;
    const trace: Trace = {
      tools: this.trace.tools.slice(from.tools),
      messages: this.trace.messages.slice(from.msgs),
      thoughts: this.trace.thoughts - from.thoughts,
      updates: this.trace.updates - from.upd,
      completed: this.trace.completed.slice(from.completed),
    };
    const out: PromptOut = { stopReason: resp?.stopReason, error, killed, ms, usage: resp?.usage, trace, text: trace.messages.join("\n") };
    this.w({ dir: "meta", ev: "prompt_end", stopReason: out.stopReason, error, killed, ms, usage: out.usage });
    return out;
  }

  async close() {
    killTree(this.pid);
    await sleep(200);
  }
}

export const isEdit = (r: ToolRec) => r.kind === "edit";
