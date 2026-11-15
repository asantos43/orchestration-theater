// Item 7: 3 sessoes simultaneas (uma por worktree) no MESMO processo do adaptador; arvore de processos e RSS/PSS.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, sleep, withAdapter } from "./lib.ts";
import { Jsonl } from "./log.ts";
import { tree, type ProcInfo } from "./proc.ts";
import { OUT, WT } from "./paths.ts";

const kb = (n: number) => Math.round(n / 1024);
const sum = (ps: ProcInfo[], k: "rssKb" | "pssKb") => ps.reduce((a, p) => a + (p[k] ?? 0), 0);
const byComm = (ps: ProcInfo[]) => ps.reduce<Record<string, number>>((a, p) => ((a[p.comm] = (a[p.comm] ?? 0) + 1), a), {});

await withAdapter("s7-concurrency", {}, async (h) => {
  const samples = new Jsonl("s7-samples");
  const sample = (phase: string) => {
    const ps = tree(h.pid);
    samples.write({ phase, n: ps.length, byComm: byComm(ps), rssMB: kb(sum(ps, "rssKb")), pssMB: kb(sum(ps, "pssKb")), procs: ps.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, rssMB: kb(p.rssKb), pssMB: p.pssKb == null ? null : kb(p.pssKb), args: p.args })) });
    return ps;
  };
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const afterInit = sample("after-initialize");

  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const r = (await h.cx.request(methods.agent.session.new, { cwd: WT(n), mcpServers: [] } as never)) as any;
    ids.push(r.sessionId);
    await pickCheap(h, r.sessionId, r);
    sample(`after-session-new-${n}`);
  }
  await sleep(1000);
  const idle = sample("idle-3-sessions");

  let stop = false;
  const peak: { rss: number; pss: number; n: number } = { rss: 0, pss: 0, n: 0 };
  const perClaudePeak = new Map<number, number>();
  const sampler = (async () => {
    while (!stop) {
      const ps = sample("running");
      const r = sum(ps, "rssKb");
      if (r > peak.rss) Object.assign(peak, { rss: r, pss: sum(ps, "pssKb"), n: ps.length });
      for (const p of ps.filter((x) => x.comm === "claude")) perClaudePeak.set(p.pid, Math.max(perClaudePeak.get(p.pid) ?? 0, p.rssKb));
      await sleep(400);
    }
  })();
  const t = Date.now();
  const rs = await Promise.all(
    ids.map((id, i) =>
      h.prompt(id, "Run the shell command `sleep 4`, then count from 1 to 150, one number per line, with no other text.", { tag: `concurrent-${i + 1}` }),
    ),
  );
  const wall = Date.now() - t;
  stop = true;
  await sampler;
  const after = sample("after-prompts");

  const idleClaude = idle.filter((p) => p.comm === "claude");
  const summary = {
    adapterRssMB_afterInit: kb(afterInit.find((p) => p.pid === h.pid)!.rssKb),
    idle: { processes: idle.length, byComm: byComm(idle), totalRssMB: kb(sum(idle, "rssKb")), totalPssMB: kb(sum(idle, "pssKb")), claudeRssMB: idleClaude.map((p) => kb(p.rssKb)) },
    peak: { processes: peak.n, totalRssMB: kb(peak.rss), totalPssMB: kb(peak.pss), perClaudePeakRssMB: [...perClaudePeak.values()].map(kb) },
    after: { processes: after.length, byComm: byComm(after), totalRssMB: kb(sum(after, "rssKb")) },
    wallMs: wall,
    prompts: rs.map((r) => ({ ms: r.ms, firstChunkMs: r.firstChunkMs, stopReason: r.stopReason, usage: r.usage, err: r.error })),
  };
  writeFileSync(join(OUT, "s7-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
});
