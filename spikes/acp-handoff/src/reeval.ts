// Reavalia a worktree de uma continuacao ja feita (deterministico) e atualiza o JSON. uso: node src/reeval.ts <nome-sem-.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, evaluate } from "./task.ts";
const f = join(OUT, `${process.argv[2]}.json`);
const r = JSON.parse(readFileSync(f, "utf8"));
r.eval = evaluate(r.dir);
writeFileSync(f, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r.eval));
