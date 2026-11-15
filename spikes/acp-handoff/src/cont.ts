// Fase B do bastao: sessao NOVA em outro cliente com o pacote de continuacao. uso: node src/cont.ts <cliente> <par> <min|full>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AcpRun, isEdit, sleep, type ClientName } from "./acp.ts";
import { buildPackage, type Variant } from "./package.ts";
import { OUT, addWorktree, diffAgainst, evaluate, numstat, progress } from "./task.ts";

const [clientName, pair, variant] = process.argv.slice(2) as [ClientName, string, Variant];
const o = JSON.parse(readFileSync(join(OUT, `origin-${pair}.json`), "utf8"));
const dir = addWorktree(`cont-${pair}-${variant}`, o.checkpoint);
const t0 = Date.now();
const pkg = buildPackage(variant, o, dir);
const buildMs = Date.now() - t0;
writeFileSync(join(OUT, `package-${pair}-${variant}.md`), pkg);

const run = new AcpRun(clientName, `cont-${pair}-${variant}`);
await run.start(dir);
const sessionId = await run.newSession(dir);
// linhas que a origem acrescentou (para medir retrabalho)
const originAdded = new Set(
  diffAgainst(dir, o.base).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter(Boolean),
);
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
await sleep(300);
await run.close();
const ev = evaluate(dir);
const finalLines = new Set(
  ["lib.mjs", "lib.test.mjs"].flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean)),
);
const lost = [...originAdded].filter((l) => !finalLines.has(l));
const tools = res.trace.tools;
const rec = {
  clientName, pair, variant, sessionId, dir,
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
writeFileSync(join(OUT, `cont-${pair}-${variant}.json`), JSON.stringify(rec, null, 2));
console.log(JSON.stringify({ ...rec, trace: undefined }, null, 1));
process.exit(0);
