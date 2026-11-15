// Item 2: bastao nativo entre ACP e o CLI do MESMO cliente, nos dois sentidos. uso: node src/native.ts <cliente> [A|B|AB]
//  A = sessao criada pelo ACP, retomada no CLI;  B = sessao criada pelo CLI, carregada por session/load no ACP.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpRun, SPEC, sleep, type ClientName } from "./acp.ts";
import { OUT, REPO, addWorktree } from "./task.ts";

const [name, dirs = "AB"] = process.argv.slice(2) as [ClientName, string?];
const WORDS = ["KIWI", "MANGO", "PAPAYA", "GUAVA", "LYCHEE", "FIG"];
const secret = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
const SAVE = (w: string) => `Remember this code word for later: ${w}. Do not use any tools. Reply with only the word OK.`;
const ASK = "What was the code word I told you earlier in this conversation? Do not use any tools. Reply with only the word.";
const sp = SPEC[name];

type Cli = { ms: number; code: number | null; sessionId?: string; text: string; raw: string };
function cli(args: string[], cwd: string, outFile?: string): Cli {
  const bin = name === "claude" ? "claude" : name;
  const t = Date.now();
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 180000, env: { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined } as NodeJS.ProcessEnv, maxBuffer: 64 << 20 });
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
  return { ms, code: r.status, sessionId, text: text.trim(), raw: raw.slice(0, 3000) };
}

const cliNew = (w: string, cwd: string) =>
  name === "claude" ? cli(["-p", "--model", sp.model, "--effort", sp.effort, "--output-format", "json", "--strict-mcp-config", SAVE(w)], cwd)
  : name === "codex" ? cli(["exec", "--json", "--skip-git-repo-check", "-m", sp.model, "-c", `model_reasoning_effort="${sp.effort}"`, SAVE(w)], cwd)
  : cli(["run", "--format", "json", "-m", sp.model, "--variant", sp.effort, "--dir", cwd, SAVE(w)], cwd);
const cliResume = (id: string, cwd: string) =>
  name === "claude" ? cli(["-p", "--resume", id, "--model", sp.model, "--effort", sp.effort, "--output-format", "json", "--strict-mcp-config", ASK], cwd)
  : name === "codex" ? cli(["exec", "resume", id, "--json", "--skip-git-repo-check", "-m", sp.model, "-c", `model_reasoning_effort="${sp.effort}"`, ASK], cwd)
  : cli(["run", "-s", id, "--format", "json", "-m", sp.model, "--variant", sp.effort, "--dir", cwd, ASK], cwd);

const out: Record<string, unknown> = { client: name };
const branchBase = "main";

if (dirs.includes("A")) {
  const cwd = addWorktree(`native-${name}-A`, branchBase);
  const w = secret();
  const run = new AcpRun(name, `native-${name}-A`);
  await run.start(cwd);
  const sid = await run.newSession(cwd);
  const p1 = await run.prompt(sid, SAVE(w));
  await run.close();
  await sleep(500);
  const r = cliResume(sid, cwd);
  out.A_acp_to_cli = { sessionId: sid, acpPrompt: { ms: p1.ms, stopReason: p1.stopReason, reply: p1.text.slice(0, 80) }, cli: { ms: r.ms, code: r.code, reply: r.text.slice(0, 200), sameSessionId: r.sessionId === undefined ? "n/d" : r.sessionId === sid }, contextRestored: r.text.includes(w), rawHead: r.raw.slice(0, 600) };
  console.log("A", JSON.stringify(out.A_acp_to_cli, null, 1));
}

if (dirs.includes("B")) {
  const cwd = addWorktree(`native-${name}-B`, branchBase);
  const w = secret();
  const c = cliNew(w, cwd);
  const sid = c.sessionId;
  const rec: Record<string, unknown> = { cliCreate: { ms: c.ms, code: c.code, sessionId: sid, reply: c.text.slice(0, 80), rawHead: c.raw.slice(0, 600) } };
  if (sid) {
    const run = new AcpRun(name, `native-${name}-B`);
    const init = await run.start(cwd);
    rec.loadSessionCapability = init?.agentCapabilities?.loadSession;
    try {
      const l = await run.load(sid, cwd);
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
writeFileSync(join(OUT, `native-${name}-${dirs}.json`), JSON.stringify(out, null, 2));
process.exit(0);
