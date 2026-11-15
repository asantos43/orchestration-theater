// Item 3: `account/rateLimits/read` direto no `codex app-server` (JSON-RPC por stdio), sem prompt de modelo.
// Mede, em 3 processos novos: tempo ate o `initialize`, tempo da primeira leitura, tempo da segunda leitura
// (processo quente, com `excludeResetCreditDetails`), RSS do app-server. Grava a resposta crua em out/ (tem accountId).
// Nunca chama `account/read` (traz e-mail) nem `account/rateLimits/consume*` (gasta credito de reset).
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OUT } from "./paths.ts";

const REPS = Number(process.argv[2] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid: number) => {
  try {
    return Math.round((Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024) * 10) / 10;
  } catch {
    return null;
  }
};

async function once(rep: number) {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (m: any) => void>();
  const notifications: any[] = [];
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  createInterface({ input: child.stdout! }).on("line", (l) => {
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    appendFileSync(join(OUT, "q3-codex-raw.jsonl"), JSON.stringify({ rep, at: new Date().toISOString(), msg: m }) + "\n");
    if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)!(m);
    else if (m.method) notifications.push(m);
  });
  let n = 0;
  const send = (method: string, params?: unknown) =>
    new Promise<any>((res) => {
      const id = ++n;
      pending.set(id, res);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const t0 = performance.now();
  const init = await send("initialize", { clientInfo: { name: "otheater-spike", title: "quota-probes", version: "0.0.0" } });
  const tInit = performance.now() - t0;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const t1 = performance.now();
  const r1 = await send("account/rateLimits/read");
  const tRead1 = performance.now() - t1;
  const rss = rssMb(child.pid!);
  const t2 = performance.now();
  const r2 = await send("account/rateLimits/read", { excludeResetCreditDetails: true });
  const tRead2 = performance.now() - t2;
  await sleep(1500);
  child.kill("SIGTERM");
  await sleep(300);
  if (child.exitCode === null) child.kill("SIGKILL");
  return {
    rep,
    initMs: Math.round(tInit),
    read1Ms: Math.round(tRead1),
    read2WarmMs: Math.round(tRead2),
    rssMbAfterRead: rss,
    userAgent: init.result?.userAgent,
    initKeys: Object.keys(init.result ?? {}),
    r1,
    r2,
    notifications: notifications.map((x) => x.method),
    stderr: stderr.slice(0, 300),
  };
}

const rows = [];
for (let i = 1; i <= REPS; i++) {
  rows.push(await once(i));
  await sleep(500);
}
writeFileSync(join(OUT, "q3-codex-summary.json"), JSON.stringify(rows, null, 2));
// resumo sem identificadores
const redact = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (/^(accountId|email|id|creditId)$/.test(k) ? "[omitido]" : v)));
console.log(JSON.stringify(rows.map((r) => ({ rep: r.rep, initMs: r.initMs, read1Ms: r.read1Ms, read2WarmMs: r.read2WarmMs, rssMbAfterRead: r.rssMbAfterRead, notifications: r.notifications, stderr: r.stderr })), null, 1));
console.log(JSON.stringify(redact(rows[0]!.r1), null, 1));
console.log(JSON.stringify(redact(rows[0]!.r2.result?.rateLimits ?? rows[0]!.r2), null, 1).slice(0, 400));
