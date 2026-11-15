// Item 5: sobrecarga da telemetria. Prompt curto, com e sem OTel, 3 repeticoes cada, intercaladas (off,on,off,on...).
// Telemetria "on" usa os intervalos padrao dos clientes e JSON/protobuf padrao; o tempo inclui o flush na saida.
import { startReceiver } from "./receiver.ts";
import { PORT, OUT, cleanEnv, PROMPT_SHORT, run } from "./common.ts";
import { codexArgs } from "./run-codex.ts";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const N = 3;
const CORR = "otheater.run_id=run-oh,otheater.step_id=step-01,otheater.executor_id=exec-oh";
const rx = await startReceiver(PORT, { quiet: true });
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const out: any = {};
const claudeOn = (tag: string) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: "1", CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp", OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/${tag}`, OTEL_RESOURCE_ATTRIBUTES: CORR,
});
const cargs = ["-p", PROMPT_SHORT, "--model", "haiku", "--effort", "low", "--output-format", "json", "--no-session-persistence"];
for (const who of ["claude", "codex"] as const) {
  const res: Record<string, number[]> = { off: [], on: [] };
  for (let i = 0; i < N; i++) {
    for (const mode of ["off", "on"] as const) {
      const tag = `oh-${who}-${mode}-${i}`;
      rmSync(join(OUT, tag), { recursive: true, force: true });
      let r;
      if (who === "claude") r = await run(tag, "claude", cargs, cleanEnv(mode === "on" ? claudeOn(tag) : {}));
      else {
        const args = mode === "on" ? codexArgs(tag, { proto: "json" }, PROMPT_SHORT) : codexArgs(tag, { proto: "json" }, PROMPT_SHORT).filter((_, k, a) => !(a[k]?.startsWith("otel.") || (a[k - 1] === "-c" && a[k]!.startsWith("otel."))) && !(a[k] === "-c" && a[k + 1]?.startsWith("otel.")));
        r = await run(tag, "codex", args, cleanEnv(mode === "on" ? { OTEL_RESOURCE_ATTRIBUTES: CORR } : {}));
      }
      res[mode]!.push(r.ms);
      console.log(tag, r.code, r.ms);
    }
  }
  out[who] = { ...res, medianOff: med(res.off!), medianOn: med(res.on!), deltaMs: med(res.on!) - med(res.off!) };
}
writeFileSync(join(OUT, "overhead.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await rx.close();
