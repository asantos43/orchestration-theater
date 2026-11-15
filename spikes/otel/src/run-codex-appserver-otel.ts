// Item 3 (3a parte): POR QUE `CODEX_CONFIG={"otel":...}` nao exporta no codex-acp? Teste direto no `codex app-server`
// (o processo que o adaptador sobe), sem adaptador e sem credencial: CODEX_HOME vazio e temporario (sem auth.json),
// so initialize + thread/start (sem chamada ao modelo). Cada variante e um processo novo do app-server.
//   none    : nenhuma config de otel (controle)
//   thread  : otel em `config` do thread/start (e o que o CODEX_CONFIG do adaptador faz)
//   toml    : [otel] em $CODEX_HOME/config.toml
//   cli     : `-c otel.*` na linha de comando do app-server (o que o wrapper do modo B faz)
//   env     : OTEL_EXPORTER_OTLP_* no ambiente (o Codex nao documenta isso)
// Uso: node src/run-codex-appserver-otel.ts [variante...]
import { startReceiver } from "./receiver.ts";
import { PORT, SCRATCH, OUT, cleanEnv, sleep } from "./common.ts";
import { BUNDLED_CODEX } from "./acp-codex/lib.ts";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CODEX_BIN = join(import.meta.dirname, "..", "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
void BUNDLED_CODEX;
const REPO = join(SCRATCH, "repo");
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["none", "thread", "toml", "cli", "env"];
const ep = (tag: string, sig: string) => `http://127.0.0.1:${PORT}/${tag}/v1/${sig}`;
const otelObj = (tag: string) => ({
  environment: "otheater-spike",
  exporter: { "otlp-http": { endpoint: ep(tag, "logs"), protocol: "json" } },
  trace_exporter: { "otlp-http": { endpoint: ep(tag, "traces"), protocol: "json" } },
  metrics_exporter: { "otlp-http": { endpoint: ep(tag, "metrics"), protocol: "json" } },
});
const tomlOtel = (tag: string) =>
  `[otel]\nenvironment = "otheater-spike"\nexporter = { otlp-http = { endpoint = "${ep(tag, "logs")}", protocol = "json" } }\ntrace_exporter = { otlp-http = { endpoint = "${ep(tag, "traces")}", protocol = "json" } }\nmetrics_exporter = { otlp-http = { endpoint = "${ep(tag, "metrics")}", protocol = "json" } }\n`;

const rx = await startReceiver(PORT, { quiet: true });
const res: Record<string, any> = {};

for (const v of variants) {
  const tag = `cdx-as-${v}`;
  rmSync(join(OUT, tag), { recursive: true, force: true });
  const home = join(SCRATCH, `codex-home-${v}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const args = ["app-server"];
  const extra: Record<string, string> = { CODEX_HOME: home, OTEL_RESOURCE_ATTRIBUTES: `otheater.run_id=run-${v},otheater.step_id=step-01,otheater.executor_id=exec-as` };
  let threadConfig: unknown = undefined;
  if (v === "thread") threadConfig = { otel: otelObj(tag) };
  if (v === "toml") writeFileSync(join(home, "config.toml"), tomlOtel(tag));
  if (v === "cli") {
    const t = (s: string) => `{otlp-http={endpoint="${ep(tag, s)}",protocol="json"}}`;
    args.push("-c", 'otel.environment="otheater-spike"', "-c", `otel.exporter=${t("logs")}`, "-c", `otel.trace_exporter=${t("traces")}`, "-c", `otel.metrics_exporter=${t("metrics")}`);
  }
  if (v === "env") {
    extra.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${PORT}/${tag}`;
    extra.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  }
  const child = spawn(CODEX_BIN, args, { env: cleanEnv(extra), cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let exited: { code: number | null; signal: string | null } | null = null;
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", () => {});
  child.on("exit", (code, signal) => (exited = { code, signal }));
  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  const t0 = Date.now();
  send({ id: 0, method: "initialize", params: { clientInfo: { name: "otheater-spike", title: "OTheater spike", version: "0.0.0" } } });
  await sleep(800);
  send({ method: "initialized" });
  const threadIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    send({ id: i, method: "thread/start", params: { cwd: REPO, ...(threadConfig ? { config: threadConfig } : {}) } });
    await sleep(600);
  }
  for (const m of stdout.matchAll(/"thread":\{"id":"([0-9a-f-]{36})"/g)) if (!threadIds.includes(m[1]!)) threadIds.push(m[1]!);
  await sleep(2500);
  child.stdin.end(); // fecha o stdin: o app-server deve encerrar e esvaziar os exportadores
  for (let i = 0; i < 80 && !exited; i++) await sleep(100);
  const closedByStdin = !!exited;
  if (!exited) {
    child.kill("SIGTERM"); // so o processo que eu criei
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  }
  await sleep(500);
  const dir = join(OUT, tag);
  const files = (() => { try { return readdirSync(dir).filter((f) => /^\d+-(metrics|logs|traces)\.json$/.test(f)); } catch { return []; } })();
  const bySignal: Record<string, number> = {};
  let records = 0;
  let withCorr = 0;
  for (const f of files) {
    const sig = f.match(/-(\w+)\.json$/)![1]!;
    bySignal[sig] = (bySignal[sig] ?? 0) + 1;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const r of j.body?.resourceSpans ?? j.body?.resourceLogs ?? j.body?.resourceMetrics ?? []) {
      const hasCorr = (r.resource?.attributes ?? []).some((a: any) => a.key === "otheater.run_id");
      const n = (r.scopeSpans ?? r.scopeLogs ?? r.scopeMetrics ?? []).reduce((s: number, sc: any) => s + (sc.spans ?? sc.logRecords ?? sc.metrics ?? []).length, 0);
      records += n;
      if (hasCorr) withCorr += n;
    }
  }
  res[v] = { threadsStarted: threadIds.length, requests: files.length, bySignal, records, recordsWithRunId: withCorr, closedByStdin, exit: exited, s: +((Date.now() - t0) / 1000).toFixed(1) };
  console.log(v, JSON.stringify(res[v]));
}
writeFileSync(join(OUT, "cdx-as-result.json"), JSON.stringify(res, null, 1));
await rx.close();
