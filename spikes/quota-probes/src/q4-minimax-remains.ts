// Item 4: `GET /v1/token_plan/remains` da MiniMax (Token Plan). PENDENTE DO DONO: precisa da chave do plano.
// A chave vem so de `MINIMAX_API_KEY` no ambiente; nunca e lida de arquivo, impressa ou gravada.
//   MINIMAX_API_KEY=... node src/q4-minimax-remains.ts [N repeticoes]
//   node src/q4-minimax-remains.ts --bad-key     # usa uma chave falsa so para ver o formato do erro (nao e a do dono)
// Grava a resposta crua em out/q4-minimax-<n>.json (sem cabecalhos) e imprime um resumo com percentuais.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./paths.ts";

const BASES = ["https://www.minimax.io", "https://api.minimax.io"]; // oficial na FAQ do M Plan; o 2o e citado por fonte secundaria
const bad = process.argv.includes("--bad-key");
const reps = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
const key = bad ? "invalid-key-for-format-test" : process.env.MINIMAX_API_KEY;
if (!key) {
  console.error("MINIMAX_API_KEY nao definida no ambiente. Medicao pendente do dono (ver README).");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Percentual USADO, tratando `*_usage_count` como RESTANTE (issue 99 do MiniMax-M2, 2026-03-27; fonte secundaria). */
function summarize(body: any) {
  const d = body?.data ?? body;
  const win = (total: unknown, left: unknown, reset: unknown) => {
    const t = num(total);
    const l = num(left);
    return {
      total: t,
      remaining_if_usage_count_is_remaining: l,
      used_pct: t && l !== null ? Math.round(((t - l) / t) * 1000) / 10 : null,
      reset_raw: reset ?? null,
    };
  };
  return {
    base_resp: body?.base_resp ?? null,
    code: body?.code ?? null,
    five_hour: win(d?.current_interval_total_count, d?.current_interval_usage_count, d?.current_interval_reset_time ?? d?.remains_time),
    weekly: win(d?.current_weekly_total_count, d?.current_weekly_usage_count, d?.current_weekly_reset_time),
    model_remains: Array.isArray(d?.model_remains) ? d.model_remains.map((m: any) => ({ model: m.model, remains: m.remains, total: m.total })) : null,
    topKeys: body && typeof body === "object" ? Object.keys(body) : null,
    dataKeys: d && typeof d === "object" ? Object.keys(d) : null,
  };
}

for (const base of BASES) {
  for (let i = 1; i <= reps; i++) {
    const t0 = performance.now();
    let status = 0;
    let body: unknown;
    let err: string | undefined;
    try {
      const r = await fetch(`${base}/v1/token_plan/remains`, { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000) });
      status = r.status;
      const text = await r.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = { nonJson: text.slice(0, 300) };
      }
    } catch (e) {
      err = String((e as Error).message ?? e);
    }
    const ms = Math.round(performance.now() - t0);
    const host = new URL(base).host;
    writeFileSync(join(OUT, `q4-minimax-${bad ? "badkey-" : ""}${host}-${i}.json`), JSON.stringify({ at: new Date().toISOString(), base, status, ms, err, body }, null, 2));
    console.log(JSON.stringify({ host, i, status, ms, err, summary: err ? null : summarize(body) }));
  }
}
