// Receptor OTLP/HTTP minimo (descartavel). Aceita /v1/metrics, /v1/logs e /v1/traces, em JSON e em protobuf.
// Cada requisicao vira um arquivo em out/<tag>/, onde <tag> e o primeiro segmento do caminho:
//   POST http://127.0.0.1:PORTA/<tag>/v1/logs  ->  out/<tag>/0001-logs.json (+ .bin quando protobuf)
// Nunca grava os cabecalhos Authorization / x-api-key / cookie.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { gunzipSync, inflateSync } from "node:zlib";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js").opentelemetry.proto.collector;

export const OUT = join(import.meta.dirname, "..", "out");
const TYPES: Record<string, any> = {
  metrics: root.metrics.v1.ExportMetricsServiceRequest,
  logs: root.logs.v1.ExportLogsServiceRequest,
  traces: root.trace.v1.ExportTraceServiceRequest,
};
const SECRET_HEADERS = /^(authorization|x-api-key|cookie|proxy-authorization|x-.*-key|x-.*-token)$/i;

/** traceId/spanId chegam em base64 (bytes:String); em JSON OTLP eles sao hex. Converte para hex. */
function fixIds(x: any): any {
  if (Array.isArray(x)) return x.map(fixIds);
  if (x && typeof x === "object") {
    const o: any = {};
    for (const [k, v] of Object.entries(x)) {
      if ((k === "traceId" || k === "spanId" || k === "parentSpanId") && typeof v === "string") o[k] = Buffer.from(v, "base64").toString("hex");
      else o[k] = fixIds(v);
    }
    return o;
  }
  return x;
}

export function decodeProto(signal: string, buf: Buffer) {
  const T = TYPES[signal];
  const msg = T.decode(buf);
  return fixIds(T.toObject(msg, { longs: String, enums: String, bytes: String, defaults: false }));
}

export function startReceiver(port: number, opts: { quiet?: boolean } = {}) {
  const counters = new Map<string, number>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = url.pathname.match(/^\/(?:([\w.-]+)\/)?v1\/(metrics|logs|traces)\/?$/);
      if (req.method !== "POST" || !m) {
        res.writeHead(404).end();
        return;
      }
      const tag = m[1] ?? "default";
      const signal = m[2]!;
      let body = Buffer.concat(chunks);
      const enc = String(req.headers["content-encoding"] ?? "");
      try {
        if (enc === "gzip") body = gunzipSync(body);
        else if (enc === "deflate") body = inflateSync(body);
      } catch {}
      const ctype = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
      const dir = join(OUT, tag);
      mkdirSync(dir, { recursive: true });
      const n = (counters.get(tag) ?? 0) + 1;
      counters.set(tag, n);
      const base = `${String(n).padStart(4, "0")}-${signal}`;
      let decoded: any;
      let error: string | undefined;
      try {
        if (ctype === "application/json") decoded = JSON.parse(body.toString("utf8"));
        else if (ctype === "application/x-protobuf") {
          decoded = decodeProto(signal, body);
          writeFileSync(join(dir, base + ".bin"), body);
        } else error = `content-type inesperado: ${ctype}`;
      } catch (e) {
        error = String((e as Error).message);
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !SECRET_HEADERS.test(k)));
      writeFileSync(join(dir, base + ".json"), JSON.stringify({ receivedAt: new Date().toISOString(), method: req.method, path: url.pathname, ctype, encoding: enc || undefined, bytes: body.length, headers, error, body: decoded }, null, 1));
      appendFileSync(join(dir, "index.jsonl"), JSON.stringify({ t: Date.now(), n, signal, ctype, bytes: body.length, enc: enc || undefined, error }) + "\n");
      if (!opts.quiet) console.log(`[receptor] ${tag} #${n} ${signal} ${ctype} ${body.length}B${error ? " ERRO " + error : ""}`);
      if (ctype === "application/json") res.writeHead(200, { "content-type": "application/json" }).end("{}");
      else res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  return new Promise<{ close: () => Promise<void>; port: number }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ port, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 47300);
  await startReceiver(port);
  console.log(`[receptor] ouvindo em 127.0.0.1:${port}, gravando em ${OUT}/<tag>/`);
}
