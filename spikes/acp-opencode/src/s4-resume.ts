// Item 6: session/load em processo novo e após kill -9 no meio de uma tarefa; onde ficam as sessões
import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as acp from '@agentclientprotocol/sdk/unstable';
import { startAgent } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';
import { tree } from './lib/proc.ts';

const DB = join(homedir(), '.local/share/opencode/opencode.db');
const sizes = () => Object.fromEntries(['', '-wal', '-shm'].map((x) => [`opencode.db${x}`, existsSync(DB + x) ? statSync(DB + x).size : null]));
const out: Record<string, any> = { dbPath: DB, sizesBefore: sizes() };

function countReplay(listeners: Set<(n: acp.SessionNotification) => void>) {
  const counts: Record<string, number> = {};
  let text = '';
  const l = (n: acp.SessionNotification) => {
    const u = n.update as any;
    counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1;
    if (u.content?.text) text += u.content.text;
    if (u.rawInput) text += JSON.stringify(u.rawInput);
  };
  listeners.add(l);
  return { counts, get text() { return text; }, stop: () => listeners.delete(l) };
}

// --- 4a: tarefa terminada ---
const cwd = WT[0];
let sessionId: string;
{
  const ag = await startAgent({ name: 's4a-task', cwd });
  await initialize(ag);
  const s = await newSession(ag, cwd);
  sessionId = s.sessionId;
  await pickCheap(ag, sessionId);
  const r = await ag.prompt(sessionId, 'Create the file resume-note.txt containing the number 4242. Then reply with exactly the word: done', 's4a-finished-task');
  out.finishedTask = { sessionId, stopReason: r.stopReason, ms: r.ms, toolCalls: r.toolCalls, text: r.text.slice(0, 100), usage: r.usage };
  await ag.close();
}
out.sizesAfter4a = sizes();

// --- 4b: processo novo + session/load com o mesmo cwd ---
{
  const ag = await startAgent({ name: 's4b-load', cwd });
  const init = await initialize(ag);
  out.loadSessionCap = init.agentCapabilities?.loadSession;
  const rep = countReplay(ag.listeners);
  const t = performance.now();
  const lr = await ag.a.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
  out.load_sameCwd = {
    ms: Math.round(performance.now() - t),
    responseKeys: Object.keys(lr), model: (lr.configOptions as any[])?.find((o) => o.id === 'model')?.currentValue,
    replayCounts: { ...rep.counts }, replayContainsNumber4242: rep.text.includes('4242'), replayChars: rep.text.length,
  };
  rep.stop();
  // list e resume (sem prompt)
  try {
    const list = await ag.a.request(acp.methods.agent.session.list, { cwd });
    out.sessionList = { n: (list as any).sessions?.length, first: (list as any).sessions?.[0] && Object.keys((list as any).sessions[0]), containsOurs: (list as any).sessions?.some((x: any) => x.sessionId === sessionId) };
  } catch (e: any) { out.sessionList = { error: String(e?.message ?? e) }; }
  // load com cwd diferente (outra worktree)
  try {
    const lr2 = await ag.a.request(acp.methods.agent.session.load, { sessionId, cwd: WT[1], mcpServers: [] });
    out.load_otherCwd = { ok: true, keys: Object.keys(lr2) };
  } catch (e: any) { out.load_otherCwd = { ok: false, error: String(e?.message ?? e), data: e?.data }; }
  // load de id inexistente
  try {
    await ag.a.request(acp.methods.agent.session.load, { sessionId: 'ses_doesnotexist000', cwd, mcpServers: [] });
    out.load_missing = { ok: true };
  } catch (e: any) { out.load_missing = { ok: false, error: String(e?.message ?? e), code: e?.code }; }
  // o contexto voltou? (1 prompt)
  const r = await ag.prompt(sessionId, 'What number did I ask you to write in a file earlier in this conversation? Answer with just the number. Do not use tools.', 's4b-context-after-load');
  out.contextAfterLoad = { stopReason: r.stopReason, text: r.text.slice(0, 100), has4242: r.text.includes('4242'), usage: r.usage };
  await ag.close();
}

// --- 4c: kill -9 no meio de uma tarefa ---
let crashId: string;
{
  const ag = await startAgent({ name: 's4c-crash', cwd });
  await initialize(ag);
  const s = await newSession(ag, cwd);
  crashId = s.sessionId;
  await pickCheap(ag, crashId);
  let killed = false;
  let before: any[] = [];
  let after: any[] = [];
  ag.listeners.add((n) => {
    const u = n.update as any;
    if (u.sessionUpdate === 'agent_message_chunk' && !killed) {
      killed = true;
      setTimeout(() => {
        before = tree(ag.pid);
        process.kill(ag.pid, 'SIGKILL');
        out.killedAtMs = Math.round(ag.wire.now());
        setTimeout(() => { after = before.filter((p) => existsSync(`/proc/${p.pid}`)); }, 1500);
      }, 2000);
    }
  });
  const r = await ag.prompt(crashId, 'Count from 1 to 80, one number per line with a short English word. Do not use tools.', 's4c-task-to-kill');
  await new Promise((r) => setTimeout(r, 2000));
  out.crash = {
    sessionId: crashId, promptStopReason: r.stopReason, promptError: (r.response as any).error ? String((r.response as any).error?.message ?? (r.response as any).error) : null,
    textBeforeKill: r.text.length, exit: ag.exit, procTreeBeforeKill: before.map((p) => ({ pid: p.pid, comm: p.comm })),
    survivorsAfterKill: after.map((p) => ({ pid: p.pid, comm: p.comm })),
  };
  for (const p of after) { try { process.kill(p.pid, 'SIGKILL'); } catch {} } // limpeza de órfãos
  await ag.close();
}
out.sizesAfterCrash = sizes();
{
  const ag = await startAgent({ name: 's4d-load-after-crash', cwd });
  await initialize(ag);
  const rep = countReplay(ag.listeners);
  try {
    const lr = await ag.a.request(acp.methods.agent.session.load, { sessionId: crashId, cwd, mcpServers: [] });
    out.loadAfterCrash = { ok: true, replayCounts: { ...rep.counts }, replayChars: rep.text.length, startsWith: rep.text.slice(0, 40) };
    rep.stop();
  } catch (e: any) { out.loadAfterCrash = { ok: false, error: String(e?.message ?? e), data: e?.data }; }
  await ag.close();
}

// --- armazenamento (só metadados: caminho, tamanho, contagens) ---
try {
  const db = new DatabaseSync(DB, { readOnly: true });
  const tables = db.prepare("select name from sqlite_master where type='table' order by 1").all().map((r: any) => r.name);
  const counts: Record<string, number> = {};
  for (const t of tables) { try { counts[t] = (db.prepare(`select count(*) c from "${t}"`).get() as any).c; } catch {} }
  out.dbTables = counts;
  db.close();
} catch (e: any) { out.dbTables = { error: String(e?.message ?? e) }; }
out.sizesFinal = sizes();
writeFileSync(join(OUT, 's4.result.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
