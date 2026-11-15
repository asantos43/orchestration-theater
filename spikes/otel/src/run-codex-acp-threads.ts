// Item 3 (4a parte): de onde vem a thread `conversation.id` extra por sessao do codex-acp?
// Hipotese (leitura do codex-acp 2.6.0, TitleGenerator): apos o 1o turno de cada sessao sem titulo explicito, o adaptador
// abre um `thread/start {ephemeral:true}` com TITLE_MODEL e um prompt de 560 caracteres para gerar o titulo.
// Teste: wrapper em CODEX_PATH (modo B, ver run-codex-acp.ts) + sessoes alternadas: normal / `session/set_title` antes do
// 1o prompt. Se a hipotese vale, so as sessoes normais geram a thread extra.
// Uso: node src/run-codex-acp-threads.ts [N_PARES=1]   (cada par = 2 prompts ao modelo)
import { startReceiver } from "./receiver.ts";
import { PORT, SCRATCH, OUT, cleanEnv, PROMPT_SHORT, sleep } from "./common.ts";
import { Adapter, newSession, runPrompt, BUNDLED_CODEX } from "./acp-codex/lib.ts";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(SCRATCH, "repo");
const MODEL = process.env.CODEX_MODEL ?? "gpt-6-luna";
const PAIRS = Number(process.argv[2] ?? 1);
const tag = "codex-acp-threads";
const val = (v: any) => (v && ("stringValue" in v ? v.stringValue : "intValue" in v ? Number(v.intValue) : "boolValue" in v ? v.boolValue : JSON.stringify(v)));
const flat = (kvs: any[] = []) => Object.fromEntries(kvs.map((a) => [a.key, val(a.value)]));

rmSync(join(OUT, tag), { recursive: true, force: true });
const rx = await startReceiver(PORT, { quiet: true });
const toml = (sig: string) => `{otlp-http={endpoint="http://127.0.0.1:${PORT}/${tag}/v1/${sig}",protocol="json"}}`;
const w = join(SCRATCH, "codex-otel-wrapper-threads.sh");
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(w, `#!/bin/sh\nexec "${BUNDLED_CODEX}" -c 'otel.environment="otheater-spike"' -c 'otel.exporter=${toml("logs")}' -c 'otel.trace_exporter=${toml("traces")}' -c 'otel.metrics_exporter=${toml("metrics")}' "$@"\n`);
chmodSync(w, 0o755);

const a = Adapter.start({ name: `otel-${tag}`, env: cleanEnv({ OTEL_RESOURCE_ATTRIBUTES: "otheater.run_id=run-threads,otheater.step_id=step-01,otheater.executor_id=exec-codex-acp" }), replaceEnv: true, codexPath: w });
const sessions: { label: string; explicitTitle: boolean; sessionId: string; stopReason?: string; ms?: number; titleUpdates: string[] }[] = [];
let error: string | undefined;
try {
  await a.initialize();
  a.permission = "reject";
  for (let i = 0; i < PAIRS * 2; i++) {
    const explicitTitle = i % 2 === 1;
    const s = await newSession(a, REPO, undefined, { model: MODEL, reasoning_effort: "low", mode: "read-only" });
    if (explicitTitle) await (a.agent as any).request("session/set_title", { sessionId: s.sessionId, title: "titulo-explicito-do-spike" });
    const before = a.updates.length;
    const p = await runPrompt(a, s.sessionId, PROMPT_SHORT, `otel-${tag}-${i}`);
    await sleep(6000); // da tempo da thread de titulo (se existir) rodar e ser exportada
    const titles = a.updates.filter((u) => u.sessionId === s.sessionId && (u.update as any).sessionUpdate === "session_info_update" && (u.update as any).title).map((u) => String((u.update as any).title));
    void before;
    sessions.push({ label: `s${i + 1}`, explicitTitle, sessionId: s.sessionId, stopReason: p.stopReason, ms: p.ms, titleUpdates: titles });
  }
  await sleep(6000);
} catch (e: any) {
  error = String(e?.message ?? e).slice(0, 500);
}
await a.stop();
await sleep(1500);

// analise: threads vistas nos logs OTel
type Th = { conv: string; sessionAcp: boolean; explicitTitle?: boolean; startedAtMs: number; promptLength?: number; model?: string; sandbox?: string; events: Record<string, number> };
const threads = new Map<string, Th>();
const dir = join(OUT, tag);
const files = readdirSync(dir).filter((f) => /^\d+-logs\.json$/.test(f)).sort();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const r of j.body?.resourceLogs ?? []) for (const sc of r.scopeLogs ?? []) for (const l of sc.logRecords ?? []) {
    const at = flat(l.attributes);
    const c = at["conversation.id"];
    if (!c) continue;
    const ev = String(at["event.name"] ?? "?");
    const sess = sessions.find((s) => s.sessionId === c);
    const t: Th = threads.get(c) ?? { conv: c, sessionAcp: !!sess, explicitTitle: sess?.explicitTitle, startedAtMs: Date.parse(String(at["event.timestamp"])), events: {} };
    t.events[ev] = (t.events[ev] ?? 0) + 1;
    if (ev === "codex.user_prompt") { t.promptLength = Number(at["prompt_length"]); t.model = String(at["model"]); }
    if (ev === "codex.conversation_starts") t.sandbox = String(at["sandbox_policy"]);
    threads.set(c, t);
  }
}
const list = [...threads.values()].sort((x, y) => x.startedAtMs - y.startedAtMs).map((t) => ({ conv: t.conv.slice(0, 13), tipo: t.sessionAcp ? `sessao ACP (titulo explicito=${t.explicitTitle})` : "EXTRA", prompt_length: t.promptLength, model: t.model, sandbox: t.sandbox, nEventos: Object.values(t.events).reduce((s, n) => s + n, 0), usoModelo: t.events["codex.sse_event"] ?? 0 }));
const extras = [...threads.values()].filter((t) => !t.sessionAcp);
const out = { pairs: PAIRS, sessions: sessions.map((s) => ({ ...s, sessionId: s.sessionId.slice(0, 13) })), threadsNosLogs: list, extras: extras.length, error, stderrTail: a.stderrText.slice(-300) };
writeFileSync(join(OUT, `${tag}-result.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await rx.close();
