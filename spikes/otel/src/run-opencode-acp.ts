// Item 4 (2a parte): o OpenCode emite span de chamada ao modelo quando o prompt usa uma ferramenta? Via `opencode acp`
// (processo proprio, porta 47530; NUNCA a porta 4096 do dono). Hipotese (strings do binario 1.19.5): os spans de
// chamada ao modelo (AI SDK `experimental_telemetry`) so existem com `experimental.openTelemetry=true` na config;
// aqui ligado por OPENCODE_CONFIG_CONTENT (nao mexe em ~/.config/opencode).
// Cenarios: off (sem a chave) e on (com a chave); N sessoes cada, com prompt que le hello.txt.
// Uso: node src/run-opencode-acp.ts [N=2] [off|on ...]
import { startReceiver } from "./receiver.ts";
import { PORT, SCRATCH, OUT, cleanEnv, PROMPT_TOOL, sleep } from "./common.ts";
import { Adapter, runPrompt } from "./acp-codex/lib.ts";
import { methods } from "@agentclientprotocol/sdk";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(SCRATCH, "repo");
const MODEL = process.env.OC_MODEL ?? "google/gemini-3.1-flash-lite";
const N = Number(process.argv[2] ?? 2);
const scen = process.argv.slice(3).length ? process.argv.slice(3) : ["off", "on"];
const MARKER = readFileSync(join(REPO, "hello.txt"), "utf8").trim(); // conteudo do arquivo de teste (para detectar vazamento)
const val = (v: any) => (v && ("stringValue" in v ? v.stringValue : "intValue" in v ? Number(v.intValue) : "boolValue" in v ? v.boolValue : "doubleValue" in v ? v.doubleValue : JSON.stringify(v)));
const flat = (kvs: any[] = []) => Object.fromEntries(kvs.map((a) => [a.key, val(a.value)]));
const rx = await startReceiver(PORT, { quiet: true });
const res: Record<string, any> = {};

for (const sc of scen) {
  const tag = `oc-acp-${sc}`;
  rmSync(join(OUT, tag), { recursive: true, force: true });
  const env = cleanEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}/${tag}`,
    OTEL_RESOURCE_ATTRIBUTES: `otheater.run_id=run-oc-${sc},otheater.step_id=step-01,otheater.executor_id=exec-opencode-acp`,
    OTEL_SERVICE_NAME: "opencode-spike",
    ...(sc === "on" ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { openTelemetry: true } }) } : {}),
  });
  const a = Adapter.start({ name: `otel-${tag}`, command: "opencode", commandArgs: ["acp", "--port", "47530"], cwd: REPO, env, replaceEnv: true });
  const r: any = { scenario: sc, sessions: [] };
  res[sc] = r;
  try {
    await a.initialize();
    a.permission = "allow";
    for (let i = 1; i <= N; i++) {
      const s: any = await a.agent.request(methods.agent.session.new, { cwd: REPO, mcpServers: [] });
      const models = (s.configOptions ?? []).find((o: any) => o.id === "model");
      if (!models?.options?.some((o: any) => o.value === MODEL)) throw new Error(`modelo ${MODEL} nao listado`);
      await a.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: MODEL });
      const p = await runPrompt(a, s.sessionId, PROMPT_TOOL, `otel-${tag}-s${i}`, false);
      r.sessions.push({ sessionId: String(s.sessionId).slice(0, 12), stopReason: p.stopReason, ms: p.ms, text: p.agentText.slice(0, 60), tools: p.tools.map((t: any) => `${t.ev}:${t.kind ?? ""}:${t.status ?? ""}`).slice(0, 6), usage: p.usage });
    }
    await sleep(6000);
  } catch (e: any) {
    r.error = String(e?.message ?? e).slice(0, 400);
  }
  await a.stop();
  await sleep(1500);
  // analise
  const dir = join(OUT, tag);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^\d+-(logs|traces|metrics)\.json$/.test(f)); } catch {}
  const names = new Map<string, number>();
  const aiSpans: any[] = [];
  const logMsgs = new Map<string, number>();
  let withRunId = 0, records = 0, markerFiles = 0;
  const promptHit = new Set<string>();
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    if (raw.includes(MARKER)) markerFiles++;
    if (raw.includes("hello.txt")) promptHit.add(f.replace(/^\d+-/, ""));
    const j = JSON.parse(raw);
    for (const rs of j.body?.resourceSpans ?? []) {
      const hasCorr = (rs.resource?.attributes ?? []).some((x: any) => x.key === "otheater.run_id");
      for (const s of rs.scopeSpans ?? []) for (const sp of s.spans ?? []) {
        records++; if (hasCorr) withRunId++;
        names.set(sp.name, (names.get(sp.name) ?? 0) + 1);
        if (/^ai\.|gen_ai|llm|streamText|doStream|toolCall/i.test(sp.name)) aiSpans.push({ name: sp.name, attrs: flat(sp.attributes) });
      }
    }
    for (const rl of j.body?.resourceLogs ?? []) for (const s of rl.scopeLogs ?? []) for (const l of s.logRecords ?? []) {
      records++; withRunId += (rl.resource?.attributes ?? []).some((x: any) => x.key === "otheater.run_id") ? 1 : 0;
      const m = String(val(l.body) ?? "").slice(0, 50);
      logMsgs.set(m, (logMsgs.get(m) ?? 0) + 1);
    }
  }
  const aiNames: Record<string, number> = {};
  for (const s of aiSpans) aiNames[s.name] = (aiNames[s.name] ?? 0) + 1;
  const mask = (k: string, v: any) => (typeof v === "string" ? v.replace(/\/home\/[^/\s"]+/g, "/home/<usuario>").slice(0, 120) : v);
  const sample = aiSpans.find((s) => /^ai\.streamText$/.test(s.name)) ?? aiSpans[0];
  const usageAttrs = aiSpans.flatMap((s) => Object.entries(s.attrs).filter(([k]) => /usage|model|finish|operation|tool\.name/.test(k)).map(([k, v]) => `${s.name}|${k}=${mask(k, v)}`));
  r.otel = {
    requests: files.length,
    records, recordsComRunId: withRunId,
    spanNamesTotal: names.size,
    spansComPrefixoAi: aiNames,
    atributosDeUmSpanAi: sample ? Object.fromEntries(Object.entries(sample.attrs).map(([k, v]) => [k, typeof v === "string" ? `<${String(v).length} car.>` : v])) : null,
    usoEModelo: [...new Set(usageAttrs)].slice(0, 30),
    arquivosComConteudoDoArquivoLido: markerFiles,
    arquivosComNomeDoArquivoNoPrompt: promptHit.size,
    spansComNomeSugestivo: [...names].filter(([n]) => /Session\.|LLM|Provider\.|prompt|stream|tool/i.test(n)).map(([n, c]) => `${n} x${c}`).slice(0, 25),
  };
  console.log(sc, JSON.stringify(r, null, 1));
}
writeFileSync(join(OUT, "oc-acp-result.json"), JSON.stringify(res, null, 1));
await rx.close();
