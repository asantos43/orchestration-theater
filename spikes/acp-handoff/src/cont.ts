// Fase B do bastao: sessao NOVA em outro cliente com o pacote de continuacao. uso: node src/cont.ts <cliente> <par> <min|full>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AcpRun, SPEC, isEdit, killTree, sleep, type ClientName } from "./acp.ts";
import { buildPackage, type Variant } from "./package.ts";
import { OUT, addWorktree, diffAgainst, evaluate, numstat, progress } from "./task.ts";

const [clientName, pair, variant] = process.argv.slice(2) as [ClientName, string, Variant];
// OT_ORIGIN: nome do registro de origem em out/ (origin-<OT_ORIGIN>.json); padrao = o proprio par. Permite reaproveitar
//   a mesma origem para destinos diferentes (par "claude-opencode" usa a origem "claude-codex").
// OT_TAG: sufixo da repeticao (ex. "r3"); vira cont-<par>-<variante>.<tag>.json. OT_MODEL: modelo do OpenCode (ver acp.ts).
// OT_WATCHDOG_MS: vigia da execucao em ms (padrao 600000). Modelo local: OPENCODE_CONFIG_CONTENT (herdado do ambiente) acrescenta o provedor; ver rep5.sh.
const originName = process.env.OT_ORIGIN ?? pair;
const tag = process.env.OT_TAG ? `.${process.env.OT_TAG}` : "";
const runName = `cont-${pair}-${variant}${tag}`;
const o = JSON.parse(readFileSync(join(OUT, `origin-${originName}.json`), "utf8"));
const dir = addWorktree(runName.replace(/\./g, "-"), o.checkpoint);
const t0 = Date.now();
const pkg = buildPackage(variant, o, dir);
const buildMs = Date.now() - t0;
writeFileSync(join(OUT, `package-${pair}-${variant}${tag}.md`), pkg);

const run = new AcpRun(clientName, runName);
await run.start(dir);
const sessionId = await run.newSession(dir);
// linhas que a origem acrescentou (para medir retrabalho)
const originAdded = new Set(
  diffAgainst(dir, o.base).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter(Boolean),
);
const watchdog = setTimeout(() => killTree(run.pid), Number(process.env.OT_WATCHDOG_MS ?? 600_000)); // trava de seguranca (padrao 10 min; OT_WATCHDOG_MS muda)
const snaps: unknown[] = [];
let seen = 0;
const res = await run.prompt(sessionId, pkg, (t) => {
  if (t.completed.length !== seen) {
    seen = t.completed.length;
    const last = t.tools.find((x) => x.id === t.completed.at(-1));
    snaps.push({ at: Date.now() - t0, tool: `${last?.kind}|${last?.title}`.slice(0, 80), steps: progress(dir).n });
  }
  return false;
});
clearTimeout(watchdog);
await sleep(300);
await run.close();
const ev = evaluate(dir);
const finalLines = new Set(
  ["lib.mjs", "lib.test.mjs"].flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean)),
);
const lost = [...originAdded].filter((l) => !finalLines.has(l));
const tools = res.trace.tools;
const rec = {
  clientName, pair, variant, tag: tag.slice(1) || undefined, originName, model: SPEC[clientName].model, sessionId, dir,
  package: { bytes: Buffer.byteLength(pkg), chars: pkg.length, estTokens: Math.round(pkg.length / 4), buildMs },
  stopReason: res.stopReason, error: res.error, ms: res.ms, usage: res.usage, permissions: run.perms,
  eval: ev, numstatVsCheckpoint: numstat(dir, o.checkpoint),
  rework: { originAddedLines: originAdded.size, originLinesMissingInFinal: lost.length, lostSample: lost.slice(0, 5) },
  counts: {
    tools: tools.length, edits: tools.filter(isEdit).length, reads: tools.filter((t) => t.kind === "read").length,
    execs: tools.filter((t) => t.kind === "execute").length, other: tools.filter((t) => !["edit", "read", "execute"].includes(t.kind ?? "")).length,
    thoughts: res.trace.thoughts,
  },
  snaps, finalText: res.text.slice(0, 500), trace: res.trace,
};
writeFileSync(join(OUT, `${runName}.json`), JSON.stringify(rec, null, 2));
console.log(JSON.stringify({ ...rec, trace: undefined }, null, 1));
process.exit(0);
