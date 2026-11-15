// Item 2: claude-agent-acp lancado com as variaveis OTel. As variaveis chegam ao `claude` filho?
// Da para mudar os atributos por sessao? (`_meta.claudeCode.options.env` no session/new)
import { startReceiver } from "./receiver.ts";
import { PORT, REPO, OUT, cleanEnv, PROMPT_TOOL, sleep } from "./common.ts";
import { withAdapter, INIT_PARAMS, pickCheap } from "./acp-claude/lib.ts";
import { methods } from "@agentclientprotocol/sdk";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const corr = (run: string, step: string, exec: string) => `otheater.run_id=${run},otheater.step_id=${step},otheater.executor_id=${exec}`;
const fast = { OTEL_METRIC_EXPORT_INTERVAL: "2000", OTEL_LOGS_EXPORT_INTERVAL: "1000", OTEL_TRACES_EXPORT_INTERVAL: "1000" };
const adapterEnv = cleanEnv({
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/claude-acp`,
  OTEL_RESOURCE_ATTRIBUTES: corr("run-ADAPTER", "step-ADAPTER", "exec-ADAPTER"),
  ...fast,
});

for (const t of ["claude-acp", "claude-acp-s2"]) rmSync(join(OUT, t), { recursive: true, force: true });
const rx = await startReceiver(PORT, { quiet: true });
const t0 = Date.now();
const res: any = { sessions: [] };
await withAdapter("claude-acp-otel", { replaceEnv: true, env: adapterEnv }, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const mk = async (label: string, env?: Record<string, string>) => {
    const r = (await h.cx.request(methods.agent.session.new, { cwd: REPO, mcpServers: [], ...(env ? { _meta: { claudeCode: { options: { env } } } } : {}) } as never)) as any;
    await pickCheap(h, r.sessionId, r);
    res.sessions.push({ label, sessionId: r.sessionId, env: env ? Object.keys(env) : "(nenhuma: herda do adaptador)" });
    return r.sessionId as string;
  };
  // s1: muda so os atributos de recurso; s2: muda atributos E endpoint; s3: nada (herda do adaptador)
  const s1 = await mk("s1", { OTEL_RESOURCE_ATTRIBUTES: corr("run-S1", "step-S1", "exec-S1") });
  const s2 = await mk("s2", { OTEL_RESOURCE_ATTRIBUTES: corr("run-S2", "step-S2", "exec-S2"), OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/claude-acp-s2` });
  const s3 = await mk("s3");
  for (const [label, sid] of [["s1", s1], ["s2", s2], ["s3", s3]] as const) {
    const p = await h.prompt(sid, PROMPT_TOOL, { tag: `otel-${label}` });
    res.sessions.find((s: any) => s.label === label).prompt = { ms: p.ms, stopReason: p.stopReason, text: p.text.slice(0, 40) };
  }
  // pais dos processos: o adaptador cria um `claude` por sessao?
  await sleep(6000); // deixa os exportadores esvaziarem
});
res.totalMs = Date.now() - t0;
writeFileSync(join(OUT, "claude-acp-result.json"), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
await rx.close();
