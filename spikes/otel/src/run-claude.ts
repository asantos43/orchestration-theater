// Item 1: `claude -p` (haiku, esforco low) exportando OTel para o receptor local.
// Uso: node src/run-claude.ts <config>...   (sem argumentos: todas)
import { startReceiver } from "./receiver.ts";
import { PORT, REPO, cleanEnv, PROMPT_TOOL, run, saveRun } from "./common.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./common.ts";

const CORR = "otheater.run_id=run-claude-0001,otheater.step_id=step-01,otheater.executor_id=exec-claude-haiku";
const base = (proto: string, extra: Record<string, string> = {}) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: proto,
  OTEL_RESOURCE_ATTRIBUTES: CORR,
  ...extra,
});
const fast = { OTEL_METRIC_EXPORT_INTERVAL: "2000", OTEL_LOGS_EXPORT_INTERVAL: "1000", OTEL_TRACES_EXPORT_INTERVAL: "1000" };

export const CONFIGS: Record<string, Record<string, string>> = {
  // padroes de privacidade, intervalos curtos so para ver varias exportacoes
  "claude-json": base("http/json", fast),
  "claude-proto": base("http/protobuf", fast),
  // intervalos padrao (60 s / 5 s): o que chega antes de o processo sair?
  "claude-defint": base("http/protobuf"),
  // tudo que vaza: prompts, respostas, detalhes de ferramenta, conteudo de ferramenta
  "claude-leak": base("http/json", { ...fast, OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1" }),
  // controles de cardinalidade desligados: o que some das metricas?
  "claude-min": base("http/json", { ...fast, OTEL_METRICS_INCLUDE_SESSION_ID: "false", OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false", OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false" }),
};

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(CONFIGS);
const rx = await startReceiver(PORT, { quiet: true });
for (const tag of names) {
  rmSync(join(OUT, tag), { recursive: true, force: true });
  const env = cleanEnv({ ...CONFIGS[tag]!, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/${tag}` });
  const r = await run(tag, "claude", ["-p", PROMPT_TOOL, "--model", "haiku", "--effort", "low", "--output-format", "json", "--no-session-persistence"], env);
  let res: any = {};
  try { res = JSON.parse(r.stdout); } catch {}
  saveRun(r, { clientResult: { duration_ms: res.duration_ms, num_turns: res.num_turns, total_cost_usd: res.total_cost_usd, usage: res.usage, result: String(res.result ?? "").slice(0, 100), is_error: res.is_error } });
  console.log(tag, "code", r.code, "ms", r.ms, "result", String(res.result ?? r.stderr).slice(0, 80));
}
await rx.close();
