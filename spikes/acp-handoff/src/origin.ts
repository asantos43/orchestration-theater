// Fase A do bastao: comeca a tarefa num cliente via ACP e mata o adaptador depois de N edicoes concluidas.
// uso: node src/origin.ts <cliente> <par> [N=3]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpRun, isEdit, sleep, type ClientName } from "./acp.ts";
import { ORDERS, OUT, addWorktree, baseSha, checkpoint, evaluate, numstat, progress } from "./task.ts";

const [clientName, pair, nArg] = process.argv.slice(2) as [ClientName, string, string?];
const N = Number(nArg ?? 3);
const base = baseSha();
const dir = addWorktree(`origin-${pair}`, base);
const run = new AcpRun(clientName, `origin-${pair}`);
await run.start(dir);
const sessionId = await run.newSession(dir);
const stopWhen = (t: { tools: any[] }) => t.tools.filter((x) => isEdit(x) && x.status === "completed").length >= N;
const res = await run.prompt(sessionId, ORDERS, stopWhen);
await sleep(800); // deixa o disco assentar depois do kill
await run.close();
const cp = checkpoint(dir, `checkpoint (${clientName}, interrupted=${res.killed})`);
const pr = progress(dir);
const rec = {
  clientName, pair, sessionId, base, checkpoint: cp, dir, killed: res.killed, stopReason: res.stopReason, error: res.error, ms: res.ms,
  usage: res.usage, progress: pr, numstat: numstat(dir, base), eval: res.killed ? undefined : evaluate(dir), trace: res.trace,
};
writeFileSync(join(OUT, `origin-${pair}.json`), JSON.stringify(rec, null, 2));
console.log(JSON.stringify({ ...rec, trace: { tools: res.trace.tools.map((t) => `${t.kind}|${t.status}|${t.title}`), msgs: res.trace.messages.length } }, null, 1));
process.exit(0);
