// Item 3 (2a parte): codex-acp com OTel. Como injetar `otel.*`? Quais atributos chegam? Mudam por sessao?
// Modo A: CODEX_CONFIG (JSON do adaptador, vai no `config` do thread/start).
// Modo B: CODEX_PATH aponta para um wrapper que roda `codex -c otel.*=... app-server`.
// Uso: node src/run-codex-acp.ts [A|B]...
import { startReceiver } from "./receiver.ts";
import { PORT, SCRATCH, OUT, cleanEnv, PROMPT_SHORT, sleep } from "./common.ts";
import { Adapter, newSession, runPrompt, BUNDLED_CODEX } from "./acp-codex/lib.ts";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(SCRATCH, "repo");
const MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const corr = (run: string) => `otheater.run_id=${run},otheater.step_id=step-01,otheater.executor_id=exec-codex-acp`;
const ep = (tag: string, sig: string) => ({ "otlp-http": { endpoint: `http://127.0.0.1:${PORT}/${tag}/v1/${sig}`, protocol: "json" } });
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["A", "B"];
const res: any = {};
const rx = await startReceiver(PORT, { quiet: true });

for (const mode of modes) {
  const tag = `codex-acp-${mode.toLowerCase()}`;
  rmSync(join(OUT, tag), { recursive: true, force: true });
  const env: Record<string, string> = cleanEnv({ OTEL_RESOURCE_ATTRIBUTES: corr(`run-ADAPTER-${mode}`) });
  let codexPath: string | undefined;
  if (mode === "A") {
    env.CODEX_CONFIG = JSON.stringify({ otel: { environment: "otheater-spike", exporter: ep(tag, "logs"), trace_exporter: ep(tag, "traces"), metrics_exporter: ep(tag, "metrics") } });
  } else {
    const toml = (sig: string) => `{otlp-http={endpoint="http://127.0.0.1:${PORT}/${tag}/v1/${sig}",protocol="json"}}`;
    const w = join(SCRATCH, "codex-otel-wrapper.sh");
    mkdirSync(SCRATCH, { recursive: true });
    writeFileSync(w, `#!/bin/sh\nexec "${BUNDLED_CODEX}" -c 'otel.environment="otheater-spike"' -c 'otel.exporter=${toml("logs")}' -c 'otel.trace_exporter=${toml("traces")}' -c 'otel.metrics_exporter=${toml("metrics")}' "$@"\n`);
    chmodSync(w, 0o755);
    codexPath = w;
  }
  const a = Adapter.start({ name: `otel-${tag}`, env, replaceEnv: true, codexPath });
  const r: any = { mode, sessions: [] };
  res[mode] = r;
  try {
    await a.initialize();
    a.permission = "reject";
    for (const label of ["s1", "s2"]) {
      const s = await newSession(a, REPO, undefined, { model: MODEL, reasoning_effort: "low", mode: "read-only" });
      const p = await runPrompt(a, s.sessionId, PROMPT_SHORT, `otel-${tag}-${label}`);
      r.sessions.push({ label, sessionId: s.sessionId, stopReason: p.stopReason, ms: p.ms, text: p.agentText.slice(0, 40) });
    }
    await sleep(8000);
  } catch (e: any) {
    r.error = String(e?.message ?? e).slice(0, 500);
  }
  await a.stop();
  r.stderrTail = a.stderrText.slice(-600).replace(/\/home\/[^/\s"]+/g, "/home/<user>");
  await sleep(1500);
}
writeFileSync(join(OUT, "codex-acp-result.json"), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
await rx.close();
