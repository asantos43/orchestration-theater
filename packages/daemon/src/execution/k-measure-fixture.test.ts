// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  classify,
  formatStopReasons,
  formatTable,
  formatTsv,
  linuxProcFs,
  parseCmdline,
  parseKValues,
  parseMemAvailableMb,
  parseSmapsRollup,
  parseStat,
  peakSample,
  planCells,
  sampleTree,
  seenPids,
  stampOf,
  median,
  type MeasureRow,
  type ProcFs,
  type ProcFile,
} from './k-measure-fixture.js';

interface FakeProcess {
  readonly pid: number;
  readonly comm: string;
  readonly ppid: number;
  readonly pgrp?: number;
  readonly session?: number;
  readonly argv?: readonly string[];
  readonly rssKb?: number;
  readonly pssKb?: number;
}

/** A `/proc` in memory: only what the sampler reads. */
function fakeProc(processes: readonly FakeProcess[]): ProcFs {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return {
    pids: () => processes.map((p) => p.pid),
    read: (pid, file: ProcFile) => {
      const p = byPid.get(pid);
      if (p === undefined) return undefined;
      if (file === 'stat') {
        return `${String(p.pid)} (${p.comm}) S ${String(p.ppid)} ${String(p.pgrp ?? p.pid)} ${String(p.session ?? p.pid)} 0 0\n`;
      }
      if (file === 'cmdline') return `${(p.argv ?? [p.comm]).join('\0')}\0`;
      if (p.rssKb === undefined) return undefined;
      return `Rss:  ${String(p.rssKb)} kB\nPss:  ${String(p.pssKb ?? p.rssKb)} kB\n`;
    },
  };
}

describe('parseStat', () => {
  it('reads ppid, group and session', () => {
    expect(parseStat('42 (node) S 7 42 42 0 -1 4194560')).toEqual({
      pid: 42,
      comm: 'node',
      ppid: 7,
      pgrp: 42,
      session: 42,
    });
  });

  it('splits at the last parenthesis when the name has spaces and parentheses', () => {
    expect(parseStat('9 (tmux: server) (x)) S 1 9 9 0')).toMatchObject({
      pid: 9,
      comm: 'tmux: server) (x)',
      ppid: 1,
    });
  });

  it('refuses text that is not a stat line', () => {
    expect(parseStat('')).toBeUndefined();
    expect(parseStat('1 (a) S x y z')).toBeUndefined();
  });
});

describe('parseSmapsRollup, parseMemAvailableMb, parseCmdline', () => {
  it('reads Rss and Pss, and nothing when one is missing', () => {
    const text = '00400000-ff [rollup]\nRss:  1234 kB\nPss:   600 kB\nPss_Anon: 5 kB\n';
    expect(parseSmapsRollup(text)).toEqual({ rssKb: 1234, pssKb: 600 });
    expect(parseSmapsRollup('Rss: 1 kB\n')).toBeUndefined();
  });

  it('reads MemAvailable in MB', () => {
    expect(parseMemAvailableMb('MemTotal: 100 kB\nMemAvailable:    2097152 kB\n')).toBe(2048);
    expect(parseMemAvailableMb('MemTotal: 100 kB\n')).toBeUndefined();
  });

  it('splits the NUL separated arguments', () => {
    expect(parseCmdline('node\0/x/claude-agent-acp\0')).toEqual(['node', '/x/claude-agent-acp']);
    expect(parseCmdline('')).toEqual([]);
  });
});

describe('classify', () => {
  it.each([
    ['node', ['node', '/home/x/node_modules/.bin/claude-agent-acp'], 'adapter'],
    ['codex-acp', ['codex-acp'], 'adapter'],
    ['claude', ['claude', '--output-format', 'stream-json'], 'claude'],
    ['claude', ['/home/x/.local/bin/claude'], 'claude'],
    ['node', ['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js'], 'claude'],
    ['codex', ['codex', 'app-server'], 'codex-app-server'],
    ['codex', ['codex', 'login'], 'other'],
    ['opencode', ['opencode', 'acp'], 'opencode'],
    ['.opencode', ['/x/.opencode', 'acp'], 'opencode'],
    ['sh', ['sh', '-c', 'true'], 'other'],
  ] as const)('%s %j is %s', (comm, argv, kind) => {
    expect(classify(comm, argv)).toBe(kind);
  });
});

describe('sampleTree', () => {
  const procs = fakeProc([
    { pid: 1, comm: 'systemd', ppid: 0, rssKb: 9999 },
    // Tree of root 100: adapter -> claude -> shell; a second, unrelated tree at 200.
    {
      pid: 100,
      comm: 'node',
      ppid: 50,
      argv: ['node', '/x/claude-agent-acp'],
      rssKb: 2048,
      pssKb: 1024,
    },
    { pid: 101, comm: 'claude', ppid: 100, pgrp: 100, session: 100, rssKb: 4096, pssKb: 3072 },
    { pid: 102, comm: 'sh', ppid: 101, pgrp: 100, session: 100, rssKb: 512, pssKb: 256 },
    // Adopted by init after its parent died, still in the session of the root.
    { pid: 103, comm: 'mcp', ppid: 1, pgrp: 103, session: 100, rssKb: 1024, pssKb: 512 },
    { pid: 200, comm: 'node', ppid: 50, argv: ['node', '/y/claude-agent-acp'], rssKb: 8192 },
    // A root whose smaps cannot be read still counts as a process.
    { pid: 300, comm: 'opencode', ppid: 50, argv: ['opencode', 'acp'] },
  ]);

  it('adds the root, its descendants and the leftovers of its session, by kind', () => {
    const sample = sampleTree(procs, [100], 750);
    expect(sample.at).toBe(750);
    expect(sample.pids).toEqual([100, 101, 102, 103]);
    expect(sample.processes).toBe(4);
    expect(sample.rssKb).toBe(2048 + 4096 + 512 + 1024);
    expect(sample.pssKb).toBe(1024 + 3072 + 256 + 512);
    expect(sample.byKind.adapter).toEqual({ count: 1, rssKb: 2048, pssKb: 1024 });
    expect(sample.byKind.claude.count).toBe(1);
    expect(sample.byKind.other.count).toBe(2);
    expect(sample.byKind.opencode.count).toBe(0);
    expect(sample.unreadable).toBe(0);
  });

  it('keeps trees apart, counts a process with no readable memory and ignores a dead root', () => {
    const sample = sampleTree(procs, [200, 300, 999], 0);
    expect(sample.pids).toEqual([200, 300]);
    expect(sample.unreadable).toBe(1);
    expect(sample.rssKb).toBe(8192);
    expect(sample.byKind.opencode.count).toBe(1);
  });

  it('is empty for no roots', () => {
    expect(sampleTree(procs, [], 0)).toMatchObject({ processes: 0, rssKb: 0, pids: [] });
  });

  it('picks the peak by RSS and lists every pid seen', () => {
    const a = sampleTree(procs, [100], 0);
    const b = sampleTree(procs, [100, 200], 250);
    const c = sampleTree(procs, [200], 500);
    expect(peakSample([a, b, c])).toBe(b);
    expect(peakSample([])).toBeUndefined();
    expect(seenPids([a, c])).toEqual([100, 101, 102, 103, 200]);
  });
});

// The real /proc exists only on Linux.
describe.runIf(process.platform === 'linux')('linuxProcFs', () => {
  it('reads the own process on the real /proc, and nothing for a pid that does not exist', () => {
    const fs = linuxProcFs();
    expect(fs.pids()).toContain(process.pid);
    const stat = parseStat(fs.read(process.pid, 'stat') ?? '');
    expect(stat?.pid).toBe(process.pid);
    expect(fs.read(2 ** 22 + 12345, 'stat')).toBeUndefined();
    expect(linuxProcFs('/nonexistent-proc-root').pids()).toEqual([]);
  });
});

describe('planCells', () => {
  it('splits a sharing client into shared and own, once for N = 1', () => {
    expect(planCells([1, 2, 6], true)).toEqual([
      { n: 1, k: 1, layout: 'single', expectedRoots: 1 },
      { n: 2, k: 2, layout: 'shared', expectedRoots: 1 },
      { n: 2, k: 1, layout: 'own', expectedRoots: 2 },
      { n: 6, k: 6, layout: 'shared', expectedRoots: 1 },
      { n: 6, k: 1, layout: 'own', expectedRoots: 6 },
    ]);
  });

  it('has one cell per N for a client that starts one process per session', () => {
    expect(planCells([1, 4], false)).toEqual([
      { n: 1, k: 1, layout: 'single', expectedRoots: 1 },
      { n: 4, k: 1, layout: 'per-session', expectedRoots: 4 },
    ]);
  });
});

describe('parseKValues, stampOf, median', () => {
  it('defaults to 1,2,4,6 and sorts without repeats', () => {
    expect(parseKValues(undefined)).toEqual([1, 2, 4, 6]);
    expect(parseKValues('')).toEqual([1, 2, 4, 6]);
    expect(parseKValues('6, 2,2,1')).toEqual([1, 2, 6]);
  });

  it.each(['0', 'a', '1,,2', '17', '1.5', '-1'])('refuses %j', (text) => {
    expect(() => parseKValues(text)).toThrow(/OT_TEST_K_VALUES/);
  });

  it('writes the local time the way the script does', () => {
    expect(stampOf(new Date(2026, 10, 16, 9, 5, 3))).toBe('20261116-090503');
  });

  it('takes the median of an odd and an even list', () => {
    expect(median([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

const ROW: MeasureRow = {
  client: 'codex',
  layout: 'shared',
  n: 4,
  k: 4,
  phase: 'prompt',
  status: 'ok',
  expectedRoots: 1,
  foundRoots: 1,
  processes: 2,
  byKind: { adapter: 1, claude: 0, 'codex-app-server': 1, opencode: 0, other: 0 },
  rssMb: 400,
  pssMb: 300,
  peakProcesses: 3,
  peakPssMb: 310.5,
  openMs: 1200,
  wallMs: 5200,
  sessionMsMin: 4000,
  sessionMsMedian: 4500,
  sessionMsMax: 5200,
  stopReasons: formatStopReasons(['end_turn', 'end_turn', 'timeout', 'end_turn']),
  samples: 21,
  note: '',
};

describe('formatTsv, formatTable, formatStopReasons', () => {
  it('counts stop reasons by name', () => {
    expect(ROW.stopReasons).toBe('end_turn:3 timeout:1');
    expect(formatStopReasons([])).toBe('');
  });

  it('writes a header and one tab separated line per row, with empty cells for no value', () => {
    const skipped: MeasureRow = {
      ...ROW,
      phase: 'idle',
      status: 'skipped',
      byKind: undefined,
      processes: undefined,
      rssMb: undefined,
      pssMb: undefined,
      note: 'low\tmemory\nnow',
    };
    const lines = formatTsv([ROW, skipped]).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    const header = (lines[0] ?? '').split('\t');
    expect(header.slice(0, 6)).toEqual(['client', 'layout', 'n', 'k', 'phase', 'status']);
    const first = Object.fromEntries(
      header.map((name, index) => [name, (lines[1] ?? '').split('\t')[index]]),
    );
    expect(first).toMatchObject({
      client: 'codex',
      layout: 'shared',
      n: '4',
      processes: '2',
      codex_app_server: '1',
      rss_mb: '400',
      pss_mb_per_session: '75',
      peak_pss_mb: '310.5',
      wall_ms: '5200',
      stop_reasons: 'end_turn:3 timeout:1',
      note: '',
    });
    const second = (lines[2] ?? '').split('\t');
    expect(second).toHaveLength(header.length);
    expect(second[header.indexOf('processes')]).toBe('');
    expect(second[header.indexOf('note')]).toBe('low memory now');
  });

  it('prints an aligned table', () => {
    const table = formatTable([ROW]).split('\n');
    expect(table).toHaveLength(3);
    expect(table[0]).toMatch(/^client\s+layout\s+N\s+K\s+phase/);
    expect(table[1]).toMatch(/^codex\s+shared\s+4\s+4\s+prompt/);
    expect(table[1]).toContain('75');
  });
});
