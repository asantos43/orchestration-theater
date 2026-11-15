import { readdirSync, readFileSync } from 'node:fs';

export type ProcInfo = { pid: number; ppid: number; comm: string; rssKb: number; pssKb: number | null; cmd: string };

function readProc(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, rp);
    const rest = stat.slice(rp + 2).split(' ');
    const ppid = Number(rest[1]);
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    const rssKb = Number(statm[1]) * 4; // páginas de 4 KiB
    let pssKb: number | null = null;
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      pssKb = m ? Number(m[1]) : null;
    } catch {}
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').slice(0, 160);
    return { pid, ppid, comm, rssKb, pssKb, cmd };
  } catch {
    return null;
  }
}

/** Raiz + todos os descendentes (varrendo /proc). */
export function tree(root: number): ProcInfo[] {
  const all = new Map<number, ProcInfo>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const p = readProc(Number(d));
    if (p) all.set(p.pid, p);
  }
  const out: ProcInfo[] = [];
  const walk = (pid: number) => {
    const p = all.get(pid);
    if (!p) return;
    out.push(p);
    for (const c of all.values()) if (c.ppid === pid) walk(c.pid);
  };
  walk(root);
  return out;
}

export function summarize(procs: ProcInfo[]) {
  return {
    count: procs.length,
    rssMb: Math.round(procs.reduce((s, p) => s + p.rssKb, 0) / 1024),
    pssMb: procs.every((p) => p.pssKb !== null) ? Math.round(procs.reduce((s, p) => s + (p.pssKb ?? 0), 0) / 1024) : null,
    procs: procs.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, rssMb: Math.round(p.rssKb / 1024), cmd: p.cmd })),
  };
}
