// Agrupa os registros de out/<tag>/ por (otheater.run_id do recurso, session.id do registro).
// Uso: node src/group-by-session.ts <tag>...
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./common.ts";
const val = (v: any) => (v && ("stringValue" in v ? v.stringValue : "intValue" in v ? v.intValue : "boolValue" in v ? v.boolValue : JSON.stringify(v)));
const flat = (kvs: any[] = []) => Object.fromEntries(kvs.map((a) => [a.key, val(a.value)]));
for (const tag of process.argv.slice(2)) {
  const rows = new Map<string, Record<string, number>>();
  const resKeys = new Set<string>();
  for (const f of readdirSync(join(OUT, tag)).filter((f) => /^\d+-(metrics|logs|traces)\.json$/.test(f))) {
    const j = JSON.parse(readFileSync(join(OUT, tag, f), "utf8"));
    const sig = f.match(/-(\w+)\.json/)![1]!;
    for (const r of j.body?.resourceMetrics ?? j.body?.resourceLogs ?? j.body?.resourceSpans ?? []) {
      const res = flat(r.resource?.attributes);
      Object.keys(res).forEach((k) => resKeys.add(k));
      for (const sc of r.scopeMetrics ?? r.scopeLogs ?? r.scopeSpans ?? []) {
        const recs = (sc.metrics ?? []).flatMap((m: any) => (m.sum ?? m.gauge ?? m.histogram)?.dataPoints ?? []).concat(sc.logRecords ?? [], sc.spans ?? []);
        for (const rec of recs) {
          const a = flat(rec.attributes);
          const key = `${String(res["otheater.run_id"] ?? "-")}|rec:${String(a["otheater.run_id"] ?? "-")}|step=${String(res["otheater.step_id"] ?? "-")}|exec=${String(res["otheater.executor_id"] ?? "-")}|sessao=${String(a["session.id"] ?? "-").slice(0, 8)}`;
          const row = rows.get(key) ?? {};
          row[sig] = (row[sig] ?? 0) + 1;
          rows.set(key, row);
        }
      }
    }
  }
  console.log(`## ${tag}\n  chaves de recurso: ${[...resKeys].join(", ")}`);
  for (const [k, v] of [...rows].sort()) console.log(`  ${k}  ${JSON.stringify(v)}`);
}
