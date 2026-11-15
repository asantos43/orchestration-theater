// Item 7: 3 sessões simultâneas (uma por worktree): no mesmo processo e em 3 processos. Mede árvore e RSS.
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, result, newSession, runPrompt, summarizeTree, tree, sleep, now } from './lib.ts';

type Cat = 'adapter(node)' | 'app-server(codex)' | 'code-mode' | 'mcp-do-config-do-dono' | 'shell/outros';
function categorize(rootPid: number) {
  const cats: Record<Cat, { n: number; rssMB: number }> = {
    'adapter(node)': { n: 0, rssMB: 0 }, 'app-server(codex)': { n: 0, rssMB: 0 }, 'code-mode': { n: 0, rssMB: 0 },
    'mcp-do-config-do-dono': { n: 0, rssMB: 0 }, 'shell/outros': { n: 0, rssMB: 0 },
  };
  for (const p of tree(rootPid)) {
    const c: Cat = p.pid === rootPid ? 'adapter(node)' : p.cmd.includes('app-server') ? 'app-server(codex)' : p.comm === 'codex-code-mode' || p.cmd.includes('code-mode') ? 'code-mode' : /playwright|npm exec|npx/.test(p.cmd) || p.comm.startsWith('npm') ? 'mcp-do-config-do-dono' : 'shell/outros';
    cats[c].n++;
    cats[c].rssMB += p.rssKB / 1024;
  }
  for (const k of Object.keys(cats) as Cat[]) cats[k].rssMB = Math.round(cats[k].rssMB);
  const all = tree(rootPid);
  return { total: { n: all.length, rssMB: Math.round(all.reduce((x, p) => x + p.rssKB, 0) / 1024) }, cats };
}
const SLOW = "Run the shell command `sleep 6; echo ok` and then answer with the single word done.";

async function sampler(roots: () => number[], stop: { v: boolean }) {
  let peak = { n: 0, rssMB: 0 };
  while (!stop.v) {
    const rs = roots();
    const n = rs.reduce((x, r) => x + tree(r).length, 0);
    const rss = Math.round(rs.reduce((x, r) => x + tree(r).reduce((y, p) => y + p.rssKB, 0), 0) / 1024);
    if (rss > peak.rssMB) peak = { n, rssMB: rss };
    await sleep(400);
  }
  return peak;
}

// ---------- (1) 3 sessões no MESMO processo ----------
{
  const a = Adapter.start({ name: 's5a-same-process' });
  a.permission = 'allow';
  await a.initialize();
  await sleep(1500);
  const stages: Record<string, unknown> = { initOnly: categorize(a.pid) };
  const sids: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const s = await newSession(a, WT(i));
    sids.push(s.sessionId);
    await sleep(1500);
    stages[`after${i}Session(s)`] = categorize(a.pid);
  }
  const stop = { v: false };
  const peakP = sampler(() => [a.pid], stop);
  const t0 = now();
  const rs = await Promise.all(sids.map((sid, i) => runPrompt(a, sid, SLOW, `s5a-same-proc-${i + 1}`)));
  const wall = now() - t0;
  stop.v = true;
  const peak = await peakP;
  // runPrompt compartilha a.updates; só confira o resultado
  result('7a mesmo processo, 3 sessões', { stages, peakDuringPrompts: peak, wallMs: wall, results: rs.map((r) => ({ stop: r.stopReason, ms: r.ms, text: r.agentText.slice(0, 40) })), afterTree: categorize(a.pid), procs: summarizeTree(a.pid).procs });
  await a.stop();
  await sleep(1500);
}

// ---------- (2) 3 PROCESSOS, 1 sessão cada ----------
{
  const as = [1, 2, 3].map((i) => Adapter.start({ name: `s5b-proc-${i}` }));
  as.forEach((x) => (x.permission = 'allow'));
  await Promise.all(as.map((x) => x.initialize()));
  await sleep(1500);
  const stages: Record<string, unknown> = { initOnly: as.map((x) => categorize(x.pid)) };
  const sids = await Promise.all(as.map((x, i) => newSession(x, WT(i + 1)).then((s) => s.sessionId)));
  await sleep(2000);
  stages['after1SessionEach'] = as.map((x) => categorize(x.pid));
  const stop = { v: false };
  const peakP = sampler(() => as.map((x) => x.pid), stop);
  const t0 = now();
  const rs = await Promise.all(as.map((x, i) => runPrompt(x, sids[i]!, SLOW, `s5b-3proc-${i + 1}`)));
  const wall = now() - t0;
  stop.v = true;
  const peak = await peakP;
  result('7b 3 processos, 1 sessão cada', { stages, peakDuringPrompts: peak, wallMs: wall, results: rs.map((r) => ({ stop: r.stopReason, ms: r.ms, text: r.agentText.slice(0, 40) })), after: as.map((x) => categorize(x.pid)) });
  await Promise.all(as.map((x) => x.stop()));
}
process.exit(0);
