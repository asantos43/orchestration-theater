// Item 4 (bonus): OpenCode exporta OTel? Sem `--attach`: sobe o proprio processo; nunca usa a porta 4096.
import { startReceiver } from "./receiver.ts";
import { PORT, OUT, cleanEnv, PROMPT_SHORT, run, saveRun } from "./common.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const tag = "opencode";
rmSync(join(OUT, tag), { recursive: true, force: true });
const rx = await startReceiver(PORT, { quiet: true });
const env = cleanEnv({
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/${tag}`,
  OTEL_RESOURCE_ATTRIBUTES: "otheater.run_id=run-oc-0001,otheater.step_id=step-01,otheater.executor_id=exec-opencode-flash",
  OTEL_SERVICE_NAME: "opencode-spike",
});
const r = await run(tag, "opencode", ["run", "-m", "google/gemini-3.1-flash-lite", PROMPT_SHORT], env, { timeoutMs: 120000 });
saveRun(r);
console.log({ ms: r.ms, code: r.code, stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 300) });
await new Promise((x) => setTimeout(x, 3000));
await rx.close();
