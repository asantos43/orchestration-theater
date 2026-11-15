// Item 1 (complemento): o `claude` interativo, recem-aberto e SEM prompt, ja recebe `rate_limits` na statusline?
// Abre `claude` num tmux proprio (socket proprio) com statusLine.refreshInterval=1, espera o primeiro `rate_limits` nao nulo,
// mede o tempo desde a abertura e o RSS do processo `claude`, e fecha. 3 repeticoes. Nenhum prompt e enviado.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUT, REPO, SCRATCH } from "./paths.ts";

const SOCK = "otheater-qp-startup";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a: string[]) => spawnSync("tmux", ["-L", SOCK, ...a], { encoding: "utf8" });
const settings = join(SCRATCH, "settings-statusline-1s.json");
writeFileSync(
  settings,
  JSON.stringify({ statusLine: { type: "command", refreshInterval: 1, command: `node ${join(import.meta.dirname, "statusline-probe.mjs")}` } }),
);
const rssMbOfTree = (rootPid: number) => {
  // soma o RSS dos descendentes de `rootPid` (a arvore do claude)
  const pids = new Set([rootPid]);
  for (let k = 0; k < 4; k++)
    for (const d of execFileSync("ls", ["/proc"], { encoding: "utf8" }).split("\n")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = readFileSync(`/proc/${d}/status`, "utf8");
        const pp = Number(/PPid:\s+(\d+)/.exec(st)![1]);
        if (pids.has(pp)) pids.add(Number(d));
      } catch {}
    }
  let kb = 0;
  for (const p of pids) {
    try {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? 0);
    } catch {}
  }
  return { n: pids.size, mb: Math.round(kb / 1024) };
};

const rows = [];
for (let rep = 1; rep <= 3; rep++) {
  const dir = join(OUT, `statusline-startup-${rep}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  tmux("new-session", "-d", "-s", "su", "-x", "160", "-y", "50", "-c", REPO, `env QP_STATUS_DIR=${dir} claude --settings ${settings} --model haiku --effort low`);
  const panePid = Number(tmux("display-message", "-p", "-t", "su", "#{pane_pid}").stdout.trim());
  let firstCall: number | null = null;
  let firstRl: number | null = null;
  let rl: unknown = null;
  let rss: { n: number; mb: number } | null = null;
  while (Date.now() - t0 < 25000) {
    await sleep(100);
    const f = join(dir, "calls.jsonl");
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (lines.length && firstCall === null) firstCall = lines[0].ms - t0;
    const withRl = lines.find((l) => l.rate_limits);
    if (withRl) {
      firstRl = withRl.ms - t0;
      rl = withRl.rate_limits;
      rss = rssMbOfTree(panePid);
      break;
    }
  }
  const pane = tmux("capture-pane", "-p", "-t", "su").stdout;
  const trustPrompt = /trust this folder/i.test(pane);
  tmux("send-keys", "-t", "su", "/exit", "Enter");
  await sleep(2500);
  tmux("kill-server");
  const row = { rep, firstStatuslineCallMs: firstCall, firstRateLimitsMs: firstRl, rateLimits: rl, rssAtFirstRl: rss, trustPrompt };
  rows.push(row);
  console.log(JSON.stringify(row));
  await sleep(500);
}
writeFileSync(join(OUT, "q1b-startup-probe.json"), JSON.stringify(rows, null, 2));
