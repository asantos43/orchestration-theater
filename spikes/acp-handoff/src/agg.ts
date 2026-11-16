// Agrega out/cont-*.json em tabelas markdown (uma linha por execucao e uma por celula). uso: node src/agg.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./task.ts";

type Row = { pair: string; variant: string; model: string; tag: string; file: string; ok: boolean; own: string; acc: string; steps: number; ms: number; lost: number; origAdded: number; edits: number; shell: number; missing: number; extra: number; tokens: number; bytes: number; err?: string };
const rows: Row[] = [];
const excl = (r: Row) => /quota|api key has expired|high demand|internal error encountered|rate.?limit|\b429\b|unavailable|overloaded|not found|too many requests/i.test(r.err ?? "");
const exclTxt = (r: Row) => (/quota/i.test(r.err ?? "") ? "excluída (cota)" : "excluída (provedor)");
const rows_shell = (r: any) => (r.trace.tools as any[]).filter((t) => t.kind === 'execute' && /<<\s*'?EOF|>>?\s*lib|\btee\b|sed -i|apply_patch/.test(t.cmd ?? t.title ?? '')).length;
for (const f of readdirSync(OUT).filter((x) => /^cont-.*\.json$/.test(x) && !x.endsWith(".wire.jsonl"))) {
  const r = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  if (!r.eval) continue;
  const m = f.match(/^cont-(.+)-(min|full)(?:\.(r\d+))?\.json$/)!;
  // a copia sem sufixo do par codex-opencode e a repeticao 2 (duplicada); as demais sem sufixo sao a execucao 1
  if (!m[3] && m[1] === "codex-opencode") continue;
  const originName = r.originName ?? r.pair;
  let missing = 0;
  try { missing = 6 - JSON.parse(readFileSync(join(OUT, `origin-${originName}.json`), "utf8")).progress.n; } catch {}
  rows.push({
    pair: m[1], variant: m[2], model: r.model ?? (r.clientName === "opencode" ? "google/gemini-3.1-flash-lite" : ""), tag: m[3] ?? "r1", file: f,
    shell: rows_shell(r),
    ok: r.eval.ok, own: `${r.eval.own.pass}/${r.eval.own.tests}`, acc: `${r.eval.accept.pass}/5`, steps: r.eval.stepsDone, ms: r.ms,
    lost: r.rework.originLinesMissingInFinal, origAdded: r.rework.originAddedLines, edits: r.counts.edits + (rows_shell(r)), missing, extra: Math.max(0, r.counts.edits + rows_shell(r) - missing),
    tokens: r.usage?.totalTokens ?? 0, bytes: r.package.bytes, err: r.error,
  });
}
const N: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };
// rotulo legivel: claude-codex -> "Claude→Codex"; sufixos: -o2 = 2a origem, -g35f = destino com gemini-3.5-flash, -gemma = destino com o Gemma 4 E4B local no Ollama, -glm/-deepseek/-minimax = modelos free do Zen, -gemma26/-gemma31 = Gemma pelo Google
const lab = (pair: string) => { const [a, b, ...x] = pair.split("-"); return `${N[a]}→${N[b]}${x.includes("o2") ? " (origem 2)" : ""}${x.includes("g35f") ? " (3.5-flash)" : ""}${x.includes("gemma") ? " (gemma local)" : ""}${x.includes("glm") ? " (glm-5.3-flash free)" : ""}${x.includes("deepseek") ? " (deepseek-v4.1-flash free)" : ""}${x.includes("minimax") ? " (minimax-m3.1-flash free)" : ""}${x.includes("gemma26") ? " (gemma 26b google)" : ""}${x.includes("gemma31") ? " (gemma 31b google)" : ""}`; };
rows.sort((a, b) => (a.pair + a.variant + a.tag).localeCompare(b.pair + b.variant + b.tag));
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const sec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");
console.log("| Par | Variante | Execução | ok | Próprios | Aceitação | Passos | Tempo | Linhas perdidas | Escritas (faltavam) | Tokens do usage |\n|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${lab(r.pair)} | ${r.variant} | ${r.tag} | ${excl(r) ? exclTxt(r) : r.ok ? "sim" : "**não**"} | ${r.own} | ${r.acc} | ${r.steps}/6 | ${sec(r.ms)} s | ${r.lost}/${r.origAdded} | ${r.edits}${r.shell ? "†" : ""} (${r.missing}) | ${r.tokens}${r.err ? " ERRO: " + r.err.slice(0, 60) : ""} |`);
console.log("\n| Par | Variante | n | ok em n | Mediana do tempo | Faixa do tempo | Linhas perdidas (soma) | Escritas a mais (soma; por execução) | Pacote (bytes) |\n|---|---|---|---|---|---|---|---|---|");
const cells = new Map<string, Row[]>();
// execucoes que falharam por cota da API (infraestrutura) ficam na tabela por execucao, mas nao entram na celula
for (const r of rows.filter((x) => !excl(x))) cells.set(`${r.pair}|${r.variant}`, [...(cells.get(`${r.pair}|${r.variant}`) ?? []), r]);
for (const [k, rs] of cells) {
  const [pair, variant] = k.split("|");
  const t = rs.map((r) => r.ms);
  console.log(`| ${lab(pair)} | ${variant} | ${rs.length} | ${rs.filter((r) => r.ok).length} de ${rs.length} | ${sec(med(t))} s | ${sec(Math.min(...t))} a ${sec(Math.max(...t))} s | ${rs.reduce((a, r) => a + r.lost, 0)} | ${rs.reduce((a, r) => a + r.extra, 0)} (${rs.map((r) => r.extra).join(", ")}) | ${rs[0].bytes} |`);
}
