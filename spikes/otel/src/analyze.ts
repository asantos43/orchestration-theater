// Le out/<tag>/*.json (gravados pelo receptor) e resume: sinais, nomes de metricas/eventos/spans, atributos,
// presenca dos atributos de correlacao, valores redigidos e campos pessoais. Saida: texto + out/summary-<tag>.json.
// Valores pessoais (e-mail, uuid, caminhos com o usuario) aparecem mascarados no texto; o bruto fica nos arquivos de out/.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./common.ts";

type KV = { key: string; value: any };
const val = (v: any): any => {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(val);
  if ("kvlistValue" in v) return flat(v.kvlistValue.values ?? []);
  return JSON.stringify(v);
};
const flat = (kvs: KV[] | undefined): Record<string, any> => Object.fromEntries((kvs ?? []).map((a) => [a.key, val(a.value)]));

const PERSONAL = /(^|\.)(email|account_uuid|account_id|organization\.id|user\.id|user\.email|session\.id|conversation|prompt\.id|installation|host|os\.|process\.)/i;
export function mask(k: string, v: any): any {
  if (typeof v === "string") {
    if (/@/.test(v) && /email/i.test(k)) return `<e-mail ${v.length} car.>`;
    if (/(email|uuid|account|organization\.id|user\.id)/i.test(k)) return `<id ${v.length} car.>`;
    if (/\/home\/[^/\s]+/.test(v)) v = v.replace(/\/home\/[^/\s]+/g, "/home/<usuario>");
    return v.length > 160 ? v.slice(0, 160) + `...(${v.length} car.)` : v;
  }
  return v;
}
const maskObj = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, mask(k, v)]));

const CORR = ["otheater.run_id", "otheater.step_id", "otheater.executor_id"];

export function analyze(tag: string) {
  const dir = join(OUT, tag);
  const files = readdirSync(dir).filter((f) => /^\d+-(metrics|logs|traces)\.json$/.test(f)).sort();
  const run = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : null;
  const t0 = run?.startedAt as number | undefined;
  const S: any = { tag, requests: [], resourceAttrKeys: {}, scopes: {}, metrics: {}, events: {}, spans: {}, corr: { records: 0, withAll: 0, inResource: 0, inRecord: 0, missing: [] as string[] }, redacted: {}, personalKeys: {} };
  const seenPersonal = (where: string, k: string, v: any) => {
    if (/(email|account_uuid|account_id|organization\.id|user\.id)/i.test(k)) S.personalKeys[`${where}:${k}`] = mask(k, v);
  };
  const corrCheck = (what: string, res: Record<string, any>, rec: Record<string, any>) => {
    S.corr.records++;
    const inRes = CORR.every((k) => k in res);
    const inRec = CORR.every((k) => k in rec);
    if (inRes) S.corr.inResource++;
    if (inRec) S.corr.inRecord++;
    if (inRes || inRec) S.corr.withAll++;
    else if (S.corr.missing.length < 8) S.corr.missing.push(what);
  };
  const noteRedacted = (where: string, a: Record<string, any>) => {
    for (const [k, v] of Object.entries(a)) if (typeof v === "string" && /^<?\[?REDACTED\]?>?$/i.test(v.trim())) S.redacted[`${where}:${k}`] = (S.redacted[`${where}:${k}`] ?? 0) + 1;
  };
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const signal = f.match(/-(\w+)\.json$/)![1]!;
    S.requests.push({ n: f.slice(0, 4), signal, ctype: j.ctype, bytes: j.bytes, enc: j.encoding, tSec: t0 ? +((Date.parse(j.receivedAt) - t0) / 1000).toFixed(1) : null, err: j.error });
    const b = j.body ?? {};
    const resList = b.resourceMetrics ?? b.resourceLogs ?? b.resourceSpans ?? [];
    for (const r of resList) {
      const res = flat(r.resource?.attributes);
      for (const [k, v] of Object.entries(res)) {
        S.resourceAttrKeys[k] ??= mask(k, v);
        seenPersonal("recurso", k, v);
      }
      for (const sc of r.scopeMetrics ?? r.scopeLogs ?? r.scopeSpans ?? []) {
        S.scopes[`${sc.scope?.name ?? "?"}@${sc.scope?.version ?? "?"}`] = signal;
        for (const m of sc.metrics ?? []) {
          const kind = m.sum ? "sum" : m.gauge ? "gauge" : m.histogram ? "histogram" : "outro";
          const e = (S.metrics[m.name] ??= { unit: m.unit, kind, temporality: m.sum?.aggregationTemporality ?? m.histogram?.aggregationTemporality, points: 0, attrKeys: new Set<string>(), samples: [] as any[] });
          for (const dp of (m.sum ?? m.gauge ?? m.histogram)?.dataPoints ?? []) {
            e.points++;
            const a = flat(dp.attributes);
            Object.keys(a).forEach((k) => e.attrKeys.add(k));
            for (const [k, v] of Object.entries(a)) seenPersonal(`metrica ${m.name}`, k, v);
            noteRedacted("metrica", a);
            corrCheck(`metrica ${m.name}`, res, a);
            if (e.samples.length < 3) e.samples.push({ ...maskObj(a), _valor: dp.asDouble ?? dp.asInt ?? dp.sum });
          }
        }
        for (const lr of sc.logRecords ?? []) {
          const a = flat(lr.attributes);
          const name = a["event.name"] ?? (typeof val(lr.body) === "string" ? String(val(lr.body)).slice(0, 60) : "(sem nome)");
          const e = (S.events[name] ??= { n: 0, attrKeys: new Set<string>(), sample: null as any, bodyType: lr.body ? Object.keys(lr.body)[0] : null });
          e.n++;
          Object.keys(a).forEach((k) => e.attrKeys.add(k));
          for (const [k, v] of Object.entries(a)) seenPersonal(`evento ${name}`, k, v);
          noteRedacted(`evento ${name}`, a);
          corrCheck(`evento ${name}`, res, a);
          if (!e.sample) e.sample = maskObj(a);
        }
        for (const sp of sc.spans ?? []) {
          const a = flat(sp.attributes);
          const e = (S.spans[sp.name] ??= { n: 0, attrKeys: new Set<string>(), events: new Set<string>(), sample: null as any, root: 0 });
          e.n++;
          if (!sp.parentSpanId) e.root++;
          Object.keys(a).forEach((k) => e.attrKeys.add(k));
          (sp.events ?? []).forEach((ev: any) => { e.events.add(ev.name); noteRedacted(`span ${sp.name}/evento ${ev.name}`, flat(ev.attributes)); });
          noteRedacted(`span ${sp.name}`, a);
          for (const [k, v] of Object.entries(a)) seenPersonal(`span ${sp.name}`, k, v);
          corrCheck(`span ${sp.name}`, res, a);
          if (!e.sample) e.sample = maskObj(a);
        }
      }
    }
  }
  const ser = (x: any): any => (x instanceof Set ? [...x].sort() : Array.isArray(x) ? x.map(ser) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ser(v)])) : x);
  const out = ser(S);
  out.resourceAttrKeys = maskObj(out.resourceAttrKeys);
  writeFileSync(join(OUT, `summary-${tag}.json`), JSON.stringify(out, null, 1));
  return out;
}

export function report(tag: string, verbose = false) {
  const s = analyze(tag);
  const L: string[] = [];
  const sigs = s.requests.reduce((a: any, r: any) => ((a[r.signal] = (a[r.signal] ?? 0) + 1), a), {});
  L.push(`## ${tag}: requisicoes ${JSON.stringify(sigs)}; ctype ${[...new Set(s.requests.map((r: any) => r.ctype))].join(",")}`);
  L.push(`  tempos (s): ` + s.requests.map((r: any) => `${r.signal[0]}@${r.tSec}`).join(" "));
  L.push(`  recurso: ` + Object.entries(s.resourceAttrKeys).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : v}`).join("; "));
  L.push(`  escopos: ${Object.keys(s.scopes).join(", ")}`);
  L.push(`  correlacao: ${s.corr.withAll}/${s.corr.records} registros com os 3 atributos (recurso ${s.corr.inResource}, registro ${s.corr.inRecord}); sem: ${s.corr.missing.join("|") || "-"}`);
  for (const [k, m] of Object.entries<any>(s.metrics)) L.push(`  M ${k} [${m.unit ?? ""}] ${m.kind} ${m.temporality ?? ""} pts=${m.points} attrs=${m.attrKeys.join(",")}`);
  for (const [k, e] of Object.entries<any>(s.events)) L.push(`  E ${k} x${e.n} attrs=${e.attrKeys.join(",")}`);
  for (const [k, e] of Object.entries<any>(s.spans)) L.push(`  T ${k} x${e.n} raiz=${e.root} attrs=${e.attrKeys.join(",")}${e.events.length ? " eventos=" + e.events.join(",") : ""}`);
  L.push(`  redigidos: ${JSON.stringify(s.redacted)}`);
  const pk = new Map<string, string[]>();
  for (const [k, v] of Object.entries<any>(s.personalKeys)) { const [where, key] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)]; pk.set(key, [...(pk.get(key) ?? []), where]); }
  L.push(`  pessoais: ` + [...pk].map(([k, w]) => `${k} (em ${w.length} lugares; ex.: ${s.personalKeys[w[0] + ":" + k]})`).join("; "));
  if (verbose) {
    for (const [k, e] of Object.entries<any>(s.events)) L.push(`  amostra E ${k}: ${JSON.stringify(e.sample)}`);
    for (const [k, e] of Object.entries<any>(s.spans)) L.push(`  amostra T ${k}: ${JSON.stringify(e.sample)}`);
    for (const [k, m] of Object.entries<any>(s.metrics)) L.push(`  amostra M ${k}: ${JSON.stringify(m.samples[0])}`);
  }
  return L.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes("-v");
  for (const t of args.filter((a) => a !== "-v")) console.log(report(t, verbose));
}
