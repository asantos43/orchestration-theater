// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseProcStat, parsePsOutput, procFsTable, systemProcessTable } from './process-table.js';

// proc(5): after the command name come state, ppid, pgrp, session, tty_nr, tpgid, flags, minflt,
// cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice, num_threads,
// itrealvalue, starttime (the 20th field after the name).
const tail = (state: string, ppid: number, pgrp: number, start: string): string =>
  `${state} ${String(ppid)} ${String(pgrp)} 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 200`;

describe('parseProcStat', () => {
  it('reads state, ppid, pgrp and start time', () => {
    expect(parseProcStat(42, `42 (node) ${tail('S', 7, 42, '987654')}`)).toEqual({
      pid: 42,
      ppid: 7,
      pgid: 42,
      zombie: false,
      start: '987654',
    });
  });

  it('counts fields after the LAST parenthesis, so odd command names do not shift them', () => {
    const info = parseProcStat(5, `5 (a) b (c d) ${tail('R', 3, 3, '11')}`);
    expect(info).toMatchObject({ ppid: 3, pgid: 3, start: '11' });
  });

  it('marks zombies and dead entries', () => {
    expect(parseProcStat(1, `1 (x) ${tail('Z', 1, 1, '1')}`)?.zombie).toBe(true);
    expect(parseProcStat(1, `1 (x) ${tail('X', 1, 1, '1')}`)?.zombie).toBe(true);
  });

  it('returns undefined for text that is not a stat line', () => {
    expect(parseProcStat(1, '')).toBeUndefined();
    expect(parseProcStat(1, '1 (x) S 1')).toBeUndefined();
    expect(
      parseProcStat(1, `1 (x) ${tail('S', 1, 1, '1').replace(' 1 1 ', ' a b ')}`),
    ).toBeUndefined();
  });
});

describe('parsePsOutput', () => {
  it('reads the BSD ps columns, keeping the whole lstart as the start time', () => {
    const table = parsePsOutput(
      [
        '    1     0     1 Ss   Mon Nov 16 09:00:00 2026',
        '  200     1   200 S+   Mon Nov 16 09:01:02 2026',
        '  201   200   200 Z    Tue Nov 17 10:11:12 2026',
        'garbage line',
        '',
      ].join('\n'),
    );
    expect([...table.keys()]).toEqual([1, 200, 201]);
    expect(table.get(200)).toEqual({
      pid: 200,
      ppid: 1,
      pgid: 200,
      zombie: false,
      start: 'Mon Nov 16 09:01:02 2026',
    });
    expect(table.get(201)?.zombie).toBe(true);
  });
});

describe('real process table', () => {
  it.skipIf(process.platform !== 'linux')('sees this very process through /proc', async () => {
    const table = await procFsTable()();
    const me = table.get(process.pid);
    expect(me).toBeDefined();
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.zombie).toBe(false);
  });

  it('systemProcessTable lists this process', async () => {
    const table = await systemProcessTable()();
    expect(table.has(process.pid)).toBe(true);
  });

  it('an unreadable /proc is an empty table, not an error', async () => {
    expect((await procFsTable('/nonexistent-proc-dir')()).size).toBe(0);
  });
});
