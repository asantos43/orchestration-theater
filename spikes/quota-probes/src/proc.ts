import { readdirSync, readFileSync } from "node:fs";

export type ProcInfo = { pid: number; ppid: number; comm: string; rssKb: number; pssKb: number | null; args: string };

function readStatus(pid: number) {
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const g = (k: string) => s.match(new RegExp(`^${k}:\\s+(.*)$`, "m"))?.[1] ?? "";
    return { comm: g("Name"), ppid: Number(g("PPid")), rssKb: parseInt(g("VmRSS")) || 0 };
  } catch {
    return null;
  }
}
function pss(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = s.match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
// Somente o nome do executavel e as flags (palavras que comecam com "-"); sem valores, para nao vazar nada.
function shortArgs(pid: number) {
  try {
    const a = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const exe = a[0]?.split("/").pop() ?? "";
    const flags = a.slice(1).filter((x) => x.startsWith("-")).map((x) => x.split("=")[0]);
    const script = a[1] && !a[1].startsWith("-") ? a[1].split("/").slice(-2).join("/") : "";
    return [exe, script, ...flags].filter(Boolean).join(" ").slice(0, 160);
  } catch {
    return "";
  }
}

export function allPids(): number[] {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
}

/** Arvore de descendentes de `root` (inclusive). */
export function tree(root: number): ProcInfo[] {
  const byParent = new Map<number, number[]>();
  const info = new Map<number, ReturnType<typeof readStatus>>();
  for (const pid of allPids()) {
    const st = readStatus(pid);
    if (!st) continue;
    info.set(pid, st);
    byParent.set(st.ppid, [...(byParent.get(st.ppid) ?? []), pid]);
  }
  const out: ProcInfo[] = [];
  const walk = (pid: number) => {
    const st = info.get(pid);
    if (!st) return;
    out.push({ pid, ppid: st.ppid, comm: st.comm, rssKb: st.rssKb, pssKb: pss(pid), args: shortArgs(pid) });
    for (const c of byParent.get(pid) ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Processos `claude` (binario nativo do SDK) cujo pai e 1 (orfaos) ou que descendem de ninguem. */
export function findByComm(comm: string): ProcInfo[] {
  const r: ProcInfo[] = [];
  for (const pid of allPids()) {
    const st = readStatus(pid);
    if (st && st.comm === comm) r.push({ pid, ppid: st.ppid, comm: st.comm, rssKb: st.rssKb, pssKb: pss(pid), args: shortArgs(pid) });
  }
  return r;
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
