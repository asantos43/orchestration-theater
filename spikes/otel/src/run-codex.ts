// Item 3: `codex exec` (modelo mais barato, esforco low) exportando OTel por `-c otel.*`, sem editar ~/.codex/config.toml.
// Uso: node src/run-codex.ts <config>...   (sem argumentos: todas)
import { startReceiver } from "./receiver.ts";
import { PORT, OUT, cleanEnv, PROMPT_TOOL, run, saveRun } from "./common.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const CORR = "otheater.run_id=run-codex-0001,otheater.step_id=step-01,otheater.executor_id=exec-codex-luna";
const MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const ep = (tag: string, sig: string, proto: string) => `{otlp-http={endpoint="http://127.0.0.1:${PORT}/${tag}/v1/${sig}",protocol="${proto}"}}`;

type Cfg = { proto: "json" | "binary"; env?: Record<string, string>; extra?: string[]; traces?: boolean; metrics?: boolean };
export const CONFIGS: Record<string, Cfg> = {
  "codex-json": { proto: "json", env: { OTEL_RESOURCE_ATTRIBUTES: CORR } },
  "codex-bin": { proto: "binary", env: { OTEL_RESOURCE_ATTRIBUTES: CORR } },
  // sem OTEL_RESOURCE_ATTRIBUTES, so otel.span_attributes (traces) para ver se vira correlacao
  "codex-spanattr": { proto: "json", extra: [`otel.span_attributes={"otheater.run_id"="run-codex-0002","otheater.step_id"="step-02","otheater.executor_id"="exec-codex-luna"}`] },
  // tudo que pode vazar: prompt, resposta do agente, avaliacoes
  "codex-leak": { proto: "json", env: { OTEL_RESOURCE_ATTRIBUTES: CORR }, extra: ["otel.log_user_prompt=true", "otel.log_agent_responses=true"] },
  // limite de bytes do resultado de ferramenta = 0: some o conteudo?
  "codex-max0": { proto: "json", env: { OTEL_RESOURCE_ATTRIBUTES: CORR }, extra: ["otel.tool_result.max_bytes=0"] },
};

export function codexArgs(tag: string, c: Cfg, prompt = PROMPT_TOOL) {
  return [
    "exec", "--ephemeral", "-s", "read-only", "-m", MODEL, "-c", "model_reasoning_effort=low",
    "-c", `otel.environment="otheater-spike"`,
    "-c", `otel.exporter=${ep(tag, "logs", c.proto)}`,
    "-c", `otel.trace_exporter=${ep(tag, "traces", c.proto)}`,
    "-c", `otel.metrics_exporter=${ep(tag, "metrics", c.proto)}`,
    ...(c.extra ?? []).flatMap((x) => ["-c", x]),
    prompt,
  ];
}

if (import.meta.main) {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(CONFIGS);
  const rx = await startReceiver(PORT, { quiet: true });
  for (const tag of names) {
    rmSync(join(OUT, tag), { recursive: true, force: true });
    const c = CONFIGS[tag]!;
    const r = await run(tag, "codex", codexArgs(tag, c), cleanEnv(c.env ?? {}));
    saveRun(r);
    console.log(tag, "code", r.code, "ms", r.ms, "| out:", r.stdout.slice(0, 80).replace(/\n/g, " "), "| err:", r.stderr.slice(-200).replace(/\n/g, " "));
  }
  await rx.close();
}
