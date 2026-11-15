// Item 2: bastao nativo entre ACP e o CLI do MESMO cliente, nos dois sentidos. uso: node src/native.ts <cliente> [A|B|AB]
//  A = sessao criada pelo ACP, retomada no CLI;  B = sessao criada pelo CLI, carregada por session/load no ACP.
// OT_CWD2=wt|plain|same: a retomada (A: CLI; B: session/load) acontece em OUTRO cwd que o da criacao.
//  wt = outra worktree do mesmo repositorio git; plain = pasta comum fora de qualquer repositorio git; same = controle (mesmo cwd).
// OT_CLI_TIMEOUT: limite do CLI em ms (padrao 180000). Registra tambem se o processo do CLI foi morto por tempo (timedOut).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpRun, SPEC, sleep, type ClientName } from "./acp.ts";
import { OUT, REPO, SCRATCH, addWorktree } from "./task.ts";

const branchBase = "main";
const [name, dirs = "AB"] = process.argv.slice(2) as [ClientName, string?];
const WORDS = ["KIWI", "MANGO", "PAPAYA", "GUAVA", "LYCHEE", "FIG"];
const secret = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
const SAVE = (w: string) => `Remember this code word for later: ${w}. Do not use any tools. Reply with only the word OK.`;
const ASK = "What was the code word I told you earlier in this conversation? Do not use any tools. Reply with only the word.";
const sp = SPEC[name];
const CWD2 = process.env.OT_CWD2 as "wt" | "plain" | "same" | undefined; // "same" = controle: mesmo cwd, so com nome de saida proprio
const CLI_TIMEOUT = Number(process.env.OT_CLI_TIMEOUT ?? 180000);
const sfx = (CWD2 ? `-cwd2${CWD2}` : "") + (process.env.OT_NTAG ? `-${process.env.OT_NTAG}` : ""); // OT_NTAG: sufixo para repetir sem colidir com worktrees/saidas anteriores
/** cwd onde a retomada acontece: o da criacao (padrao) ou outro. */
function resumeCwd(created: string, tag: string) {
  if (!CWD2 || CWD2 === "same") return created;
  if (CWD2 === "wt") return addWorktree(`native-${name}-${tag}${sfx}-novo`, branchBase);
  return mkdtempSync(join(SCRATCH, `plain-${name}-${tag}-`));
}

type Cli = { ms: number; code: number | null; timedOut: boolean; sessionId?: string; text: string; raw: string };
function cli(args: string[], cwd: string, outFile?: string): Cli {
  const bin = name === "claude" ? "claude" : name;
  const t = Date.now();
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: CLI_TIMEOUT, env: { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined } as NodeJS.ProcessEnv, maxBuffer: 64 << 20 });
  const ms = Date.now() - t;
  const raw = (r.stdout ?? "") + (r.stderr ? `\n[stderr] ${r.stderr.slice(0, 500)}` : "");
  let sessionId: string | undefined;
  let text = "";
  if (name === "claude") {
    try {
      const o = JSON.parse(r.stdout);
      sessionId = o.session_id;
      text = String(o.result ?? "");
    } catch {}
  } else {
    const ids = new Set<string>();
    for (const line of (r.stdout ?? "").split("\n")) {
      try {
        const o = JSON.parse(line);
        const id = o.thread_id ?? o.sessionID ?? o.sessionId ?? o.part?.sessionID;
        if (id) ids.add(id);
        if (name === "codex" && o.type === "item.completed" && o.item?.type === "agent_message") text += o.item.text;
        if (name === "opencode" && o.type === "text") text += o.part?.text ?? "";
      } catch {}
    }
    sessionId = [...ids][0];
  }
  return { ms, code: r.status, timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT", sessionId, text: text.trim(), raw: raw.slice(0, 3000) };
}

const cliNew = (w: string, cwd: string) =>
  name === "claude" ? cli(["-p", "--model", sp.model, "--effort", sp.effort, "--output-format", "json", "--strict-mcp-config", SAVE(w)], cwd)
  : name === "codex" ? cli(["exec", "--json", "--skip-git-repo-check", "-m", sp.model, "-c", `model_reasoning_effort="${sp.effort}"`, SAVE(w)], cwd)
  : cli(["run", "--format", "json", "-m", sp.model, "--variant", sp.effort, "--dir", cwd, SAVE(w)], cwd);
const cliResume = (id: string, cwd: string) =>
  name === "claude" ? cli(["-p", "--resume", id, "--model", sp.model, "--effort", sp.effort, "--output-format", "json", "--strict-mcp-config", ASK], cwd)
  : name === "codex" ? cli(["exec", "resume", id, "--json", "--skip-git-repo-check", "-m", sp.model, "-c", `model_reasoning_effort="${sp.effort}"`, ASK], cwd)
  : cli(["run", "-s", id, "--format", "json", "-m", sp.model, "--variant", sp.effort, "--dir", cwd, ASK], cwd);

const out: Record<string, unknown> = { client: name, cwd2: CWD2 ?? "same" };

if (dirs.includes("A")) {
  const cwd = addWorktree(`native-${name}-A${sfx}`, branchBase);
  const w = secret();
  const run = new AcpRun(name, `native-${name}-A${sfx}`);
  await run.start(cwd);
  const sid = await run.newSession(cwd);
  const p1 = await run.prompt(sid, SAVE(w));
  await run.close();
  await sleep(500);
  const cwdR = resumeCwd(cwd, "A");
  const r = cliResume(sid, cwdR);
  out.A_acp_to_cli = { resumeCwdIsDifferent: cwdR !== cwd, sessionId: sid, acpPrompt: { ms: p1.ms, stopReason: p1.stopReason, reply: p1.text.slice(0, 80) }, cli: { ms: r.ms, code: r.code, timedOut: r.timedOut, reply: r.text.slice(0, 200), sameSessionId: r.sessionId === undefined ? "n/d" : r.sessionId === sid }, contextRestored: r.text.includes(w), rawHead: r.raw.slice(0, 600) };
  console.log("A", JSON.stringify(out.A_acp_to_cli, null, 1));
}

if (dirs.includes("B")) {
  const cwd = addWorktree(`native-${name}-B${sfx}`, branchBase);
  const w = secret();
  const c = cliNew(w, cwd);
  const sid = c.sessionId;
  const rec: Record<string, unknown> = { cliCreate: { ms: c.ms, code: c.code, sessionId: sid, reply: c.text.slice(0, 80), rawHead: c.raw.slice(0, 600) } };
  if (sid) {
    const run = new AcpRun(name, `native-${name}-B${sfx}`);
    const cwdR = resumeCwd(cwd, "B");
    rec.resumeCwdIsDifferent = cwdR !== cwd;
    const init = await run.start(cwdR);
    rec.loadSessionCapability = init?.agentCapabilities?.loadSession;
    try {
      const l = await run.load(sid, cwdR);
      const p = await run.prompt(sid, ASK);
      const replayUser = run.trace.messages.length;
      rec.acp = { loadMs: l.ms, replayedUpdates: l.replayed, followMs: p.ms, reply: p.text.slice(0, 200), stopReason: p.stopReason, contextRestored: p.text.includes(w), error: p.error, replayMessagesBeforeFollowup: replayUser };
    } catch (e) {
      rec.acp = { error: String((e as Error).message ?? e) };
    }
    await run.close();
  }
  out.B_cli_to_acp = rec;
  console.log("B", JSON.stringify(rec, null, 1));
}
writeFileSync(join(OUT, `native-${name}-${dirs}${sfx}.json`), JSON.stringify(out, null, 2));
process.exit(0);
