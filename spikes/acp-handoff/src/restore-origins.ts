// Reconstroi o repositorio de teste e os pontos de controle das 3 origens ja gravadas (a pasta de trabalho original sumiu).
// O estado do ponto de controle = base + o diff que esta dentro de out/package-<par>-min.md (diff contra a base, caminhos relativos).
// Verificacao: o pacote min e o full remontados daqui tem de ser identicos, byte a byte, aos gravados na execucao original.
// uso: SPIKE_SCRATCH=<pasta> node src/restore-origins.ts   (apaga e refaz <pasta>)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, REPO, SCRATCH, addWorktree, checkpoint, setupRepo } from "./task.ts";
import { buildPackage } from "./package.ts";

const PAIRS = ["claude-codex", "codex-opencode", "opencode-claude"];
const base = setupRepo();
console.log("repo", REPO, "base", base);
let allEqual = true;
for (const pair of PAIRS) {
  const o = JSON.parse(readFileSync(join(OUT, `origin-${pair}.json`), "utf8"));
  const pkgMin = readFileSync(join(OUT, `package-${pair}-min.md`), "utf8");
  const diff = pkgMin.match(/```diff\n([\s\S]*?)\n```\n/)![1] + "\n";
  const dir = addWorktree(`restore-${pair}`, base);
  const pf = join(SCRATCH, `${pair}.patch`);
  writeFileSync(pf, diff);
  execFileSync("git", ["apply", pf], { cwd: dir });
  const cp = checkpoint(dir, `checkpoint restored (${pair})`);
  const rec = { ...o, restoredFrom: `origin-${pair}.json`, base, checkpoint: cp, dir: o.dir, restoredDir: dir };
  writeFileSync(join(OUT, `origin-${pair}.restored.json`), JSON.stringify(rec, null, 2));
  for (const v of ["min", "full"] as const) {
    const w = addWorktree(`verify-${pair}-${v}`, cp);
    const mine = buildPackage(v, rec, w);
    const old = readFileSync(join(OUT, `package-${pair}-${v}.md`), "utf8");
    const eq = mine === old;
    allEqual &&= eq;
    console.log(pair, v, eq ? "pacote IDENTICO ao gravado" : "pacote DIFERENTE", mine.length, old.length);
    if (!eq) writeFileSync(join(SCRATCH, `verify-${pair}-${v}.md`), mine);
  }
}
console.log(allEqual ? "OK: todas as origens restauradas reproduzem os pacotes gravados" : "ATENCAO: ha diferenca");
