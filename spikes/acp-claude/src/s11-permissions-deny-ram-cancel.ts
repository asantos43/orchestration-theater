// Item 8 (complemento 2, 2026-11-15): três medições.
//   deny    : regra `deny` com padrão de comando (Bash(touch *)) contra variantes do mesmo comando; modo default, cliente com allow.
//   ram     : RAM da árvore do adaptador com 1 sessão: base, strictMcpConfig, settingSources:[] e os dois juntos (método do s7).
//   cancel  : o session/cancel mata o processo filho de uma ferramenta Bash longa (`sleep 117`)?
// Uso: node src/s11-permissions-deny-ram-cancel.ts deny|ram|cancel [caso ...]
// Todas as escritas vão para o worktree de teste (WT(1)); o `sleep` é identificado pelo pid visto na árvore antes do cancel.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, sleep, withAdapter, type Harness } from "./lib.ts";
import { now } from "./log.ts";
import { alive, tree, type ProcInfo } from "./proc.ts";
import { OUT, WT } from "./paths.ts";

const [fase, ...filtro] = process.argv.slice(2);
const T = WT(1);
const kb = (n: number) => Math.round(n / 1024);
const sum = (ps: ProcInfo[], k: "rssKb" | "pssKb") => ps.reduce((a, p) => a + (p[k] ?? 0), 0);
const byComm = (ps: ProcInfo[]) => ps.reduce<Record<string, number>>((a, p) => ((a[p.comm] = (a[p.comm] ?? 0) + 1), a), {});

const rawInits = (h: Harness, id: string) =>
  h.rawSdkMessages(id).filter((m) => m.message?.type === "system" && m.message?.subtype === "init").map((m) => m.message);
const brief = (m: any) =>
  m ? { temBash: (m.tools as string[]).includes("Bash"), nTools: m.tools?.length, permissionMode: m.permissionMode, mcp_servers: m.mcp_servers?.map((s: any) => `${s.name}:${s.status}`), plugins: m.plugins?.length, skills: m.skills?.length } : null;

async function novaSessao(h: Harness, options: Record<string, unknown> | undefined, modo?: string) {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const r: any = await h.cx.request(methods.agent.session.new, {
    cwd: T,
    mcpServers: [],
    _meta: { claudeCode: { emitRawSDKMessages: [{ type: "system", subtype: "init" }], ...(options ? { options } : {}) } },
  } as never);
  const sessionId = r.sessionId as string;
  await pickCheap(h, sessionId, r);
  if (modo) await h.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: modo } as never);
  return sessionId;
}

/** Comandos que o modelo realmente mandou ao Bash (rawInput.command) e o texto de erro das chamadas que falharam. */
function resumoTools(h: Harness, sessionId: string, from: number) {
  const ups = h.updates(sessionId, from);
  const calls = new Map<string, any>();
  for (const u of ups) {
    const x = u.update;
    if (x.sessionUpdate === "tool_call") calls.set(x.toolCallId, { titulo: x.title, kind: x.kind, comando: x.rawInput?.command, status: x.status });
    if (x.sessionUpdate === "tool_call_update") {
      const c = calls.get(x.toolCallId) ?? {};
      if (x.status) c.status = x.status;
      if (x.rawInput?.command) c.comando = x.rawInput.command;
      const txt = (x.content ?? []).map((k: any) => k?.content?.text ?? "").join(" ").trim();
      if (txt && x.status === "failed") c.erro = txt.slice(0, 240);
      calls.set(x.toolCallId, c);
    }
  }
  return [...calls.values()];
}

const res: Record<string, unknown> = {};

// ---------- deny ----------
if (fase === "deny") {
  const VARS = [
    { id: "a-direto", regra: "Bash(touch *)", cmd: "touch a.txt", arq: "a.txt" },
    { id: "b-sh-c", regra: "Bash(touch *)", cmd: `sh -c "touch b.txt"`, arq: "b.txt" },
    { id: "c-caminho", regra: "Bash(touch *)", cmd: "/usr/bin/touch c.txt", arq: "c.txt" },
    { id: "d-env", regra: "Bash(touch *)", cmd: "env touch d.txt", arq: "d.txt" },
    { id: "e-bash-c", regra: "Bash(touch *)", cmd: `bash -c 'touch e.txt'`, arq: "e.txt" },
    { id: "f-direto-formato-dois-pontos", regra: "Bash(touch:*)", cmd: "touch f.txt", arq: "f.txt" },
  ].filter((v) => !filtro.length || filtro.includes(v.id));
  for (const v of VARS) {
    rmSync(join(T, v.arq), { force: true });
    try {
      res[v.id] = await withAdapter(`s11-deny-${v.id}`, {}, async (h) => {
        const sessionId = await novaSessao(h, { settings: { permissions: { deny: [v.regra] } } }, "default");
        h.permPolicy = (req) => (h.log.write({ ev: "perm_payload", req }), { pick: "allow" });
        const texto = `Use your Bash tool to run exactly this shell command: \`${v.cmd}\`. Do not use any other tool and do not try any other way to create the file. If the command is denied, rejected or you cannot run it, reply exactly BLOCKED followed by the reason in one line and stop. Otherwise reply DONE.`;
        const n0 = h.permissions.length;
        const p = await h.prompt(sessionId, texto, { tag: `deny-${v.id}` });
        return {
          regra: v.regra,
          comandoPedido: v.cmd,
          pedidosDePermissao: h.permissions.slice(n0).map((q) => ({ titulo: q.toolCall?.title, kind: q.toolCall?.kind, comando: q.toolCall?.rawInput?.command })),
          toolCalls: resumoTools(h, sessionId, p.from),
          arquivoCriado: existsSync(join(T, v.arq)),
          stopReason: p.stopReason,
          texto: p.text.slice(0, 300),
          init: rawInits(h, sessionId).map(brief),
        };
      });
    } catch (e) {
      res[v.id] = { erro: String((e as Error).message ?? e).slice(0, 400) };
    } finally {
      rmSync(join(T, v.arq), { force: true });
    }
    console.log(v.id, JSON.stringify(res[v.id]));
  }
}

// ---------- ram ----------
if (fase === "ram") {
  const CASOS = [
    { id: "base", options: undefined },
    { id: "strict", options: { strictMcpConfig: true } },
    { id: "sources-vazio", options: { settingSources: [] } },
    { id: "strict+sources-vazio", options: { strictMcpConfig: true, settingSources: [] } },
    { id: "base-repeticao", options: undefined },
  ].filter((c) => !filtro.length || filtro.includes(c.id));
  for (const c of CASOS) {
    res[c.id] = await withAdapter(`s11-ram-${c.id}`, {}, async (h) => {
      const snap = (nome: string) => {
        const ps = tree(h.pid);
        const cl = ps.filter((p) => p.comm === "claude");
        return {
          fase: nome,
          processos: ps.length,
          byComm: byComm(ps),
          totalRssMB: kb(sum(ps, "rssKb")),
          totalPssMB: kb(sum(ps, "pssKb")),
          adaptadorRssMB: kb(ps.find((p) => p.pid === h.pid)!.rssKb),
          claudeRssMB: cl.map((p) => kb(p.rssKb)),
          claudePssMB: cl.map((p) => kb(p.pssKb ?? 0)),
          outrosRssMB: kb(sum(ps.filter((p) => p.comm !== "claude" && p.pid !== h.pid), "rssKb")),
        };
      };
      const snaps: unknown[] = [];
      await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
      snaps.push(snap("apos-initialize"));
      const sessionId = await novaSessao(h, c.options);
      await sleep(2000);
      snaps.push(snap("sessao-ociosa-2s"));
      const p = await h.prompt(sessionId, "Reply with the single word ok.", { tag: `ram-${c.id}` });
      await sleep(1000);
      snaps.push(snap("apos-prompt-1s"));
      await sleep(5000);
      snaps.push(snap("apos-prompt-6s"));
      return { stopReason: p.stopReason, totalTokens: p.usage?.totalTokens, init: rawInits(h, sessionId).map(brief), snaps };
    });
    console.log(c.id, JSON.stringify(res[c.id]));
  }
}

// ---------- cancel ----------
// O Claude Code 2.1.325 recusa `sleep N` isolado ("Blocked: standalone sleep"); por isso o comando longo é `timeout 117 tail -f /dev/null`.
// fg: comando em primeiro plano; bg: o mesmo comando com run_in_background (tarefa em segundo plano da ferramenta Bash).
if (fase === "cancel") {
  const DUR = "117";
  const CMD = `timeout ${DUR} tail -f /dev/null`;
  const procsDoComando = (raiz: number) =>
    tree(raiz).filter((p) => {
      if (p.comm === "claude" || p.pid === raiz) return false;
      try {
        return readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0").some((x) => x.includes(DUR));
      } catch {
        return false;
      }
    });
  /** estado (S, Z...) e ppid lidos de /proc: kill(pid,0) também dá "vivo" para zumbi */
  const estado = (pid: number) => {
    try {
      const st = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = st.slice(st.lastIndexOf(")") + 2).split(" ");
      return { estado: rest[0], ppid: Number(rest[1]) };
    } catch {
      return null;
    }
  };
  const VARS = [
    { id: "fg", texto: `Use your Bash tool to run exactly this shell command in the foreground (do NOT use run_in_background): \`${CMD}\`. Then reply DONE.` },
    { id: "bg", texto: `Use your Bash tool with run_in_background set to true to run exactly this shell command: \`${CMD}\`. Then reply DONE.` },
  ].filter((v) => !filtro.length || filtro.includes(v.id));
  for (const v of VARS) {
    res[v.id] = await withAdapter(`s11-cancel-${v.id}`, {}, async (h) => {
      const sessionId = await novaSessao(h, undefined, "default");
      h.permPolicy = () => ({ pick: "allow" });
      let visto: ProcInfo[] = [];
      let arvoreNoCancel: string[] = [];
      let cancelAt = 0;
      let enviado = false;
      const poll = setInterval(async () => {
        if (enviado) return;
        const s = procsDoComando(h.pid);
        if (!s.some((p) => p.comm !== "zsh" && p.comm !== "bash")) return; // espera o programa em si, não só o shell
        enviado = true;
        visto = s;
        await sleep(1500); // deixa a ferramenta rodar um pouco antes do cancel
        const t = tree(h.pid);
        arvoreNoCancel = t.map((p) => `${p.comm}:${p.pid}<-${p.ppid}`);
        visto = t.filter((p) => p.comm !== "claude" && p.pid !== h.pid && p.comm !== "MainThread"); // todos os descendentes do claude, inclusive o programa em si (tail)
        cancelAt = now();
        h.log.write({ ev: "cancel_sent", pids: visto.map((p) => p.pid) });
        await h.cx.notify(methods.agent.session.cancel, { sessionId });
      }, 150);
      const n0 = h.permissions.length;
      const p = await h.prompt(sessionId, v.texto, { tag: `cancel-${v.id}` });
      clearInterval(poll);
      const fimPrompt = now();
      const amostras: unknown[] = [];
      let decorrido = 0;
      for (const espera of [0, 500, 1500, 4000, 9000]) {
        await sleep(espera - decorrido);
        decorrido = espera;
        const noTree = new Set(tree(h.pid).map((q) => q.pid));
        amostras.push({ aposMsDoFimDoPrompt: espera, procs: visto.map((x) => ({ pid: x.pid, comm: x.comm, proc: estado(x.pid), noTreeDoAdaptador: noTree.has(x.pid) })) });
      }
      // limpeza: só os pids que vimos descenderem do nosso adaptador
      const sobrou = visto.filter((x) => alive(x.pid));
      for (const x of sobrou) {
        try {
          process.kill(x.pid, "SIGKILL");
        } catch {}
      }
      return {
        comandoPedido: CMD,
        toolCalls: resumoTools(h, sessionId, p.from),
        pedidosDePermissao: h.permissions.length - n0,
        procsVistosAntesDoCancel: visto.map((x) => ({ pid: x.pid, ppid: x.ppid, comm: x.comm })),
        arvoreNoCancel,
        stopReason: p.stopReason,
        cancelLatenciaMs: cancelAt ? fimPrompt - cancelAt : null,
        amostras,
        pidsQueSobraramEForamMortosPorNos: sobrou.map((x) => x.pid),
      };
    });
    console.log(v.id, JSON.stringify(res[v.id]));
  }
}

writeFileSync(join(OUT, `s11-${fase}${filtro.length ? "-" + filtro.join("+") : ""}.json`), JSON.stringify(res, null, 2));
