// Item 7: 3 sessões simultâneas (uma por worktree): 1 processo com 3 sessões; depois 3 processos
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent, type Agent, type PromptResult } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';
import { summarize, tree } from './lib/proc.ts';

const snap = (pids: number[]) => {
  const all = pids.flatMap((p) => tree(p));
  const s = summarize(all);
  return { count: s.count, rssMb: s.rssMb, pssMb: s.pssMb, comms: [...new Set(all.map((p) => p.comm))] };
};
function sampler(pids: number[]) {
  let peakRss = 0, peakPss = 0, peakCount = 0;
  const id = setInterval(() => {
    const s = snap(pids);
    peakRss = Math.max(peakRss, s.rssMb);
    peakPss = Math.max(peakPss, s.pssMb ?? 0);
    peakCount = Math.max(peakCount, s.count);
  }, 500);
  return { stop: () => { clearInterval(id); return { peakRssMb: peakRss, peakPssMb: peakPss, peakProcs: peakCount }; } };
}
const task = (i: number, tag: string) => `Create the file conc-${tag}-${i}.txt containing the number ${i}. Then reply with exactly the word: done`;
const brief = (r: PromptResult) => ({ stopReason: r.stopReason, ms: r.ms, firstUpdateMs: Math.round(r.firstUpdateMs ?? -1), tools: r.toolCalls.length, usage: r.usage });
const out: Record<string, any> = {};

// ---- A: um processo, 3 sessões, 3 worktrees ----
{
  const ag = await startAgent({ name: 's5a-one-process', cwd: WT[0] });
  await initialize(ag);
  out.A_afterInit = snap([ag.pid]);
  const sess: string[] = [];
  const marks: any[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await newSession(ag, WT[i]);
    sess.push(s.sessionId);
    await pickCheap(ag, s.sessionId);
    marks.push({ sessions: i + 1, ...snap([ag.pid]) });
  }
  out.A_afterEachNewSession = marks;
  const smp = sampler([ag.pid]);
  const t = performance.now();
  const rs = await Promise.all(sess.map((id, i) => ag.prompt(id, task(i + 1, 'A'), `s5a-session-${i + 1}`)));
  out.A_wallMs = Math.round(performance.now() - t);
  out.A_prompts = rs.map(brief);
  out.A_peak = smp.stop();
  out.A_afterPrompts = snap([ag.pid]);
  out.A_filesInRightWorktree = [1, 2, 3].map((i) => existsSync(join(WT[i - 1], `conc-A-${i}.txt`)));
  out.A_sessionIdsDistinct = new Set(sess).size === 3;
  await ag.close();
}

// ---- B: três processos, uma sessão cada ----
{
  const ags: Agent[] = [];
  for (let i = 0; i < 3; i++) ags.push(await startAgent({ name: `s5b-proc-${i + 1}`, cwd: WT[i] }));
  const sess: string[] = [];
  const pids = ags.map((a) => a.pid);
  await Promise.all(ags.map((a) => initialize(a)));
  out.B_afterInit = snap(pids);
  for (let i = 0; i < 3; i++) {
    const s = await newSession(ags[i], WT[i]);
    sess.push(s.sessionId);
    await pickCheap(ags[i], s.sessionId);
  }
  out.B_afterNewSessions = snap(pids);
  out.B_perProcessIdleMb = ags.map((a) => snap([a.pid]).rssMb);
  const smp = sampler(pids);
  const t = performance.now();
  const rs = await Promise.all(ags.map((a, i) => a.prompt(sess[i], task(i + 1, 'B'), `s5b-process-${i + 1}`)));
  out.B_wallMs = Math.round(performance.now() - t);
  out.B_prompts = rs.map(brief);
  out.B_peak = smp.stop();
  out.B_afterPrompts = snap(pids);
  out.B_perProcessAfterMb = ags.map((a) => snap([a.pid]).rssMb);
  out.B_filesInRightWorktree = [1, 2, 3].map((i) => existsSync(join(WT[i - 1], `conc-B-${i}.txt`)));
  await Promise.all(ags.map((a) => a.close()));
}
writeFileSync(join(OUT, 's5.result.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
