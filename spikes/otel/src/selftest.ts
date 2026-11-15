// Autoteste do receptor: manda JSON e protobuf (gerado por @opentelemetry/otlp-transformer) para as tres rotas.
import { startReceiver, OUT } from "./receiver.ts";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js").opentelemetry.proto.collector;
const PORT = 47390;
const r = await startReceiver(PORT, { quiet: true });
const res = { resource: { attributes: [{ key: "otheater.run_id", value: { stringValue: "selftest" } }] }, scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }] };
const reqs: [string, any, any][] = [
  ["logs", root.logs.v1.ExportLogsServiceRequest, { resourceLogs: [res] }],
  ["metrics", root.metrics.v1.ExportMetricsServiceRequest, { resourceMetrics: [{ resource: res.resource, scopeMetrics: [{ metrics: [{ name: "m", sum: { dataPoints: [{ asInt: 3, timeUnixNano: 1 }] } }] }] }] }],
  ["traces", root.trace.v1.ExportTraceServiceRequest, { resourceSpans: [{ resource: res.resource, scopeSpans: [{ spans: [{ name: "s", traceId: Buffer.alloc(16, 1), spanId: Buffer.alloc(8, 2) }] }] }] }],
];
for (const [sig, T, obj] of reqs) {
  const bin = T.encode(T.fromObject(obj)).finish();
  for (const [ct, body] of [["application/x-protobuf", bin], ["application/json", JSON.stringify(obj)]] as const) {
    const p = await fetch(`http://127.0.0.1:${PORT}/selftest/v1/${sig}`, { method: "POST", headers: { "content-type": ct }, body });
    console.log(sig, ct, p.status);
  }
}
await r.close();
for (const f of readdirSync(OUT + "/selftest").filter((f) => f.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(`${OUT}/selftest/${f}`, "utf8"));
  console.log(f, j.ctype, j.error ?? "ok", JSON.stringify(j.body).slice(0, 140));
}
