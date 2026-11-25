// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  answersOf,
  busyConfigExtra,
  judgeIdle,
  judgePark,
  leftoverProcesses,
  type LoggedEvent,
} from './acceptance-busy.js';

describe('busyConfigExtra', () => {
  const base = { model: 'small-model', limitsPreset: 'moderate' };

  it('uses the adapter of the PATH by default and leaves the quota statusline alone', () => {
    const text = busyConfigExtra(base);
    expect(text).toContain('    adapter: path\n');
    expect(text).toContain("quota_statusline: 'off'");
    expect(text).toContain('    profile: real');
    expect(text).toContain('    model: "small-model"');
    expect(text).toContain('  preset: moderate');
    expect(text).not.toContain('mode:');
  });

  it('takes an ACP command in place of the adapter, and the mode of the client when given', () => {
    const text = busyConfigExtra({
      ...base,
      clientCommand: '/run/wrapper.sh',
      clientMode: 'acceptEdits',
    });
    expect(text).toContain('command: { cmd: "/run/wrapper.sh", args: [] }');
    expect(text).not.toContain('adapter: path');
    expect(text).toContain('    mode: "acceptEdits"');
  });
});

describe('answersOf', () => {
  it('answers each question with its first option, else a fallback', () => {
    expect(
      answersOf({
        questions: [{ options: [{ label: 'A' }, { label: 'B' }] }, { options: [] }, {}],
      }),
    ).toEqual(['A', expect.stringContaining('best judgment'), expect.stringContaining('best')]);
  });

  it('takes anything that is not a list of questions as no question', () => {
    expect(answersOf(null)).toEqual([]);
    expect(answersOf({})).toEqual([]);
    expect(answersOf('x')).toEqual([]);
  });
});

describe('judgeIdle', () => {
  const submitted = (id: number): LoggedEvent => ({
    id,
    type: 'attempt.submitted',
    attemptId: 'att-1',
  });
  const applying = (id: number): LoggedEvent => ({
    id,
    type: 'daemon.update',
    payload: { phase: 'applying' },
  });

  it('accepts the swap that begins after the attempt ended', () => {
    expect(judgeIdle([submitted(10), applying(12)], 'att-1')).toContain('came before');
  });

  it('reads the attempt id from the payload too', () => {
    const inPayload: LoggedEvent = {
      id: 3,
      type: 'attempt.submitted',
      payload: { attemptId: 'a' },
    };
    expect(judgeIdle([inPayload, applying(4)], 'a')).toContain('event 3');
  });

  it('refuses a swap that began while the attempt was still running', () => {
    expect(() => judgeIdle([applying(5), submitted(9)], 'att-1')).toThrow(
      /before the attempt ended/,
    );
  });

  it('refuses a log without the end of the attempt or without the swap', () => {
    expect(() => judgeIdle([applying(5)], 'att-1')).toThrow(/no attempt.submitted/);
    expect(() => judgeIdle([submitted(1)], 'att-1')).toThrow(/no daemon.update/);
    expect(() => judgeIdle([submitted(1), applying(2)], 'other')).toThrow(/no attempt.submitted/);
  });
});

describe('judgePark', () => {
  const interrupted = (id: number, cause = 'daemon_restart'): LoggedEvent => ({
    id,
    type: 'session.interrupted',
    attemptId: 'att-1',
    payload: { cause },
  });
  const resumed = (id: number, form: string): LoggedEvent => ({
    id,
    type: 'session.resumed',
    attemptId: 'att-1',
    payload: { form },
  });

  it('accepts the stop and the session/load that follows', () => {
    expect(judgePark([interrupted(4), resumed(9, 'native')], 'att-1', 'native')).toContain(
      '"native"',
    );
  });

  it('refuses a handoff unless the form "any" was asked for', () => {
    const events = [interrupted(4), resumed(9, 'handoff')];
    expect(() => judgePark(events, 'att-1', 'native')).toThrow(/not by session\/load/);
    expect(judgePark(events, 'att-1', 'any')).toContain('"handoff"');
  });

  it('takes the demand run again as a form of the piece going on, except for "native"', () => {
    const opened = (id: number, attemptId: string): LoggedEvent => ({
      id,
      type: 'session.opened',
      attemptId,
    });
    const events = [interrupted(4), opened(9, 'att-1x/2')];
    // The attempt id is `<play>/<demand>/<n>`: only a later number of the same demand counts.
    const rerun = [{ ...interrupted(4), attemptId: 'p/d/1' }, opened(9, 'p/d/2')];
    expect(judgePark(rerun, 'p/d/1', 'any')).toContain('ran again as p/d/2');
    expect(() => judgePark(rerun, 'p/d/1', 'native')).toThrow(/no session\/load/);
    const other = [{ ...interrupted(4), attemptId: 'p/d/1' }, opened(9, 'p/e/2')];
    expect(() => judgePark(other, 'p/d/1', 'any')).toThrow(/no session.resumed/);
    const before = [opened(2, 'p/d/2'), { ...interrupted(4), attemptId: 'p/d/1' }];
    expect(() => judgePark(before, 'p/d/1', 'any')).toThrow(/no session.resumed/);
    expect(() => judgePark(events, 'att-1', 'any')).toThrow(/no session.resumed/);
  });

  it('refuses a resume that came before the stop, a stop for another cause and a missing resume', () => {
    expect(() => judgePark([resumed(2, 'native'), interrupted(4)], 'att-1', 'native')).toThrow(
      /no session.resumed/,
    );
    expect(() =>
      judgePark([interrupted(4, 'idle'), resumed(9, 'native')], 'att-1', 'native'),
    ).toThrow(/no session.interrupted/);
    expect(() => judgePark([interrupted(4)], 'att-1', 'native')).toThrow(/no session.resumed/);
    expect(() => judgePark([interrupted(4), resumed(9, 'native')], 'other', 'native')).toThrow(
      /no session.interrupted/,
    );
  });
});

describe('leftoverProcesses', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('finds nothing in a folder no process uses', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ot-busy-left-'));
    made.push(dir);
    expect(leftoverProcesses(dir)).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')(
    'finds a process whose working directory is inside',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'ot-busy-left-'));
      made.push(dir);
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 20000)'], {
        cwd: dir,
        stdio: 'ignore',
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const found = leftoverProcesses(dir);
        expect(found.map((entry) => entry.pid)).toContain(child.pid);
      } finally {
        child.kill('SIGKILL');
      }
    },
  );
});
