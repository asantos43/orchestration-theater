// Item 6: session/load em processo novo e depois de kill -9 no meio de uma tarefa.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, describeConfig, pickCheap, sleep, withAdapter, type Harness } from "./lib.ts";
import { alive, tree } from "./proc.ts";
import { OUT, WT } from "./paths.ts";

/** Procura `<id>.jsonl` sob ~/.claude/projects/*; so caminho e tamanho, nunca o conteudo. */
function findSessionFile(sessionId: string) {
  const root = join(homedir(), ".claude", "projects");
  const hits: { path: string; bytes: number }[] = [];
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    try {
      hits.push({ path: f.replace(homedir(), "~"), bytes: statSync(f).size });
    } catch {}
  }
  return hits;
}

async function load(h: Harness, sessionId: string, cwd: string) {
  const before = h.seen.length;
  const t = Date.now();
  let resp: any;
  let err: string | undefined;
  try {
    resp = await h.cx.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] } as never);
  } catch (e) {
    err = String((e as Error).message ?? e);
  }
  const ms = Date.now() - t;
  const ups = h.updates(sessionId, before);
  const types: Record<string, number> = {};
  for (const u of ups) types[u.update.sessionUpdate] = (types[u.update.sessionUpdate] ?? 0) + 1;
  const userText = ups.filter((u) => u.update.sessionUpdate === "user_message_chunk").map((u) => u.update.content?.text ?? "");
  const agentText = ups.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => u.update.content?.text ?? "").join("");
  h.log.write({ ev: "RESULT_load", sessionId, ms, err, types, config: resp ? describeConfig(resp) : null });
  return { resp, err, ms, types, userMessages: userText.length, userText: userText.map((s) => s.slice(0, 80)), agentChars: agentText.length, agentText: agentText.slice(0, 200) };
}

const stages = process.argv[2] ?? "abc";
const out: Record<string, unknown> = {};
const state = JSON.parse(readFileSync(join(OUT, "state-session-wt1.json"), "utf8")) as { sessionId: string; cwd: string };
out.sessionFile1 = findSessionFile(state.sessionId);

// Processo 2: carregar a sessao ja concluida de s1 (wt1), mesmo cwd
if (stages.includes("a")) await withAdapter("s6a-load-finished", {}, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const l = await load(h, state.sessionId, state.cwd);
  out.loadFinished = { ms: l.ms, err: l.err, types: l.types, userMessages: l.userMessages, userText: l.userText, agentChars: l.agentChars, modeAfterLoad: l.resp?.modes?.currentModeId };
  if (!l.err) {
    await pickCheap(h, state.sessionId, l.resp);
    const p = await h.prompt(state.sessionId, "Which two file names did I ask you to create earlier in this conversation? Answer in one short line.", { tag: "load-finished-followup" });
    out.followup = { text: p.text.slice(0, 300), stopReason: p.stopReason, usage: p.usage, firstChunkMs: p.firstChunkMs };
  }
});

// Processo 3: tarefa longa, kill -9 do adaptador no meio
let killedId = "";
const killedStatePath = join(OUT, "state-session-killed.json");
if (stages.includes("b")) await withAdapter(
  "s6b-kill9",
  {},
  async (h) => {
    await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
    const newResp = (await h.cx.request(methods.agent.session.new, { cwd: WT(3), mcpServers: [] } as never)) as any;
    killedId = newResp.sessionId as string;
    await pickCheap(h, killedId, newResp);
    let treeBefore: ReturnType<typeof tree> = [];
    let killedAt = 0;
    const adapterPid = h.pid;
    const p = h.prompt(killedId, "Count from 1 to 400, one number per line, with no other text.", {
      tag: "kill9-task",
      onFirstChunk: () => {
        setTimeout(() => {
          treeBefore = tree(adapterPid);
          killedAt = Date.now();
          h.log.write({ ev: "kill9", tree: treeBefore.map((x) => `${x.comm}:${x.pid}`) });
          process.kill(adapterPid, "SIGKILL");
        }, 800);
      },
    });
    const r = await p.catch((e) => ({ err: e }));
    await sleep(2500);
    const children = treeBefore.filter((x) => x.pid !== adapterPid);
    out.kill9 = {
      promptResult: { stopReason: (r as any).stopReason, error: (r as any).error, msAfterKill: Date.now() - killedAt },
      adapterAlive: alive(adapterPid),
      childrenAtKill: children.map((x) => ({ comm: x.comm, pid: x.pid, aliveAfter2_5s: alive(x.pid) })),
    };
    // quanto tempo os orfaos (claude e filhos) sobrevivem ao kill -9 do adaptador? (sem limpar antes de medir)
    const t1 = Date.now();
    const died: Record<string, number | null> = {};
    for (const c of children) died[`${c.comm}:${c.pid}`] = alive(c.pid) ? null : 0;
    while (Date.now() - t1 < 20000 && Object.values(died).some((v) => v === null)) {
      await sleep(250);
      for (const c of children) if (died[`${c.comm}:${c.pid}`] === null && !alive(c.pid)) died[`${c.comm}:${c.pid}`] = Date.now() - t1 + 2500;
    }
    (out.kill9 as any).orphanDiedAfterMs = died; // 0 = ja morto aos 2,5 s; null = ainda vivo apos ~22 s
    for (const c of children) if (alive(c.pid)) try { process.kill(c.pid, "SIGKILL"); } catch {}
    writeFileSync(killedStatePath, JSON.stringify({ sessionId: killedId }));
  },
  "none",
);
if (!killedId) killedId = (JSON.parse(readFileSync(killedStatePath, "utf8")) as { sessionId: string }).sessionId;
out.sessionFileKilled = findSessionFile(killedId);

// Processo 4: session/load da sessao morta por kill -9
if (stages.includes("c")) await withAdapter("s6c-load-after-kill9", {}, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const l = await load(h, killedId, WT(3));
  out.loadAfterKill = { ms: l.ms, err: l.err, types: l.types, userMessages: l.userMessages, agentChars: l.agentChars, agentTail: l.agentText.slice(-60) };
  if (!l.err) {
    await pickCheap(h, killedId, l.resp);
    const p = await h.prompt(killedId, "What was the last number you wrote? Reply with just that number, or NONE if you wrote none.", { tag: "load-after-kill-followup" });
    out.followupAfterKill = { text: p.text.slice(0, 200), stopReason: p.stopReason, usage: p.usage };
  }
});

writeFileSync(join(OUT, "s6-summary.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
