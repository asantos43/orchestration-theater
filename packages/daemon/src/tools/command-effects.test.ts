// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryStore } from '@otheater/core/testing';
import { afterEach, expect, it } from 'vitest';
import { effectsOf, openEffectsOf } from '../workspace/effects-of.js';
import {
  ATTEMPT_ID,
  makeToolsRig,
  PLAY_ID,
  realClock,
  type ToolsRig,
  type ToolsRigOptions,
} from './tools-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

const rigs: ToolsRig[] = [];

async function rigOf(options: ToolsRigOptions = {}): Promise<ToolsRig> {
  const rig = await makeToolsRig(options, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

const INSTALL = '  commands:\n    install: [node, install.js]\n';
const BASE = `${PLAY_ID}:install_deps:${ATTEMPT_ID}`;
const SHELL_BASE = `${PLAY_ID}:restricted_shell:${ATTEMPT_ID}`;

/** An install that leaves one letter per run in `runs.log`, so a test counts the runs. */
async function installRig(extra = '', options: ToolsRigOptions = {}): Promise<ToolsRig> {
  const rig = await rigOf({ tools: `${INSTALL}${extra}`, ...options });
  await rig.write(
    'install.js',
    "require('node:fs').appendFileSync('runs.log', 'x'); console.log('installed');",
  );
  return rig;
}

async function runsOf(rig: ToolsRig): Promise<number> {
  try {
    return (await readFile(join(rig.worktree, 'runs.log'), 'utf8')).length;
  } catch {
    return 0;
  }
}

async function recordsOf(rig: ToolsRig, type = 'install_deps') {
  return rig.store.sideEffects.list({ attemptId: ATTEMPT_ID, types: [type] });
}

describeWithLauncher('install_deps under the effect protocol', () => {
  it('writes the before and the after under the key of the attempt and the step', async () => {
    const rig = await installRig();
    expect(await rig.call('install_deps', {})).toMatchObject({
      exitCode: 0,
      stdout: 'installed\n',
      reused: false,
    });
    const records = await recordsOf(rig);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      idempotencyKey: `${BASE}:1`,
      type: 'install_deps',
      state: 'done',
      attemptId: ATTEMPT_ID,
      params: { program: 'node', openPolicy: 'rerun' },
    });
    expect(records[0]?.result).toMatchObject({ exitCode: 0, stdout: 'installed\n' });
  });

  it('returns the recorded reply for the same inputs, without running again', async () => {
    const rig = await installRig();
    await rig.call('install_deps', {});
    const again = await rig.call('install_deps', {});
    expect(again).toMatchObject({ exitCode: 0, stdout: 'installed\n', reused: true });
    expect(await runsOf(rig)).toBe(1);
    expect(await recordsOf(rig)).toHaveLength(1);
  });

  it('runs again, as a new step, when a dependency file changed', async () => {
    const rig = await installRig();
    await rig.write('package.json', '{"name":"a"}');
    await rig.call('install_deps', {});
    await rig.write('package.json', '{"name":"a","dependencies":{"b":"1"}}');
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: false });
    expect(await runsOf(rig)).toBe(2);
    // The new inputs are recorded too, so the next call replays them.
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: true });
    expect(await runsOf(rig)).toBe(2);
    expect((await recordsOf(rig)).map((record) => record.idempotencyKey)).toEqual([
      `${BASE}:1`,
      `${BASE}:2`,
    ]);
  });

  it('does not replay an install that came before a different one', async () => {
    const rig = await installRig();
    await rig.write('package.json', '{"v":1}');
    await rig.call('install_deps', {});
    await rig.write('package.json', '{"v":2}');
    await rig.call('install_deps', {});
    // Back to the first manifest: the last install was another one, so it runs.
    await rig.write('package.json', '{"v":1}');
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: false });
    expect(await runsOf(rig)).toBe(3);
  });

  it('records a failed install with its output and never replays it', async () => {
    const rig = await rigOf({ tools: INSTALL });
    await rig.write('install.js', "console.error('nope'); process.exit(3);");
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 3, reused: false });
    const [record] = await recordsOf(rig);
    expect(record).toMatchObject({ state: 'failed', result: { exitCode: 3 } });
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 3, reused: false });
    expect((await recordsOf(rig)).map((item) => item.state)).toEqual(['failed', 'failed']);
  });

  it('replays nothing when tools.effects.replay is never, but still records', async () => {
    const rig = await installRig('  effects:\n    replay: never\n');
    await rig.call('install_deps', {});
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: false });
    expect(await runsOf(rig)).toBe(2);
    expect(await recordsOf(rig)).toHaveLength(2);
  });

  it('writes no record when tools.effects.mode is off', async () => {
    const rig = await installRig('  effects:\n    mode: off\n');
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 0 });
    await rig.call('install_deps', {});
    expect(await runsOf(rig)).toBe(2);
    expect(await recordsOf(rig)).toHaveLength(0);
  });

  it('runs a session tied to no attempt as before', async () => {
    const rig = await installRig('', { withoutAttempt: true });
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 0 });
    expect(await recordsOf(rig)).toHaveLength(0);
  });

  it('takes the files to fingerprint from tools.effects.fingerprint_files', async () => {
    const rig = await installRig('  effects:\n    fingerprint_files: [deps.txt]\n');
    await rig.write('deps.txt', 'a');
    await rig.call('install_deps', {});
    // package.json is not watched here.
    await rig.write('package.json', '{"x":1}');
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: true });
    await rig.write('deps.txt', 'b');
    expect(await rig.call('install_deps', {})).toMatchObject({ reused: false });
    expect(await runsOf(rig)).toBe(2);
  });
});

describeWithLauncher('an install the daemon lost in the middle', () => {
  /** A step left open: a "before" of the same call, with the hash a first run wrote. */
  async function leaveOpen(rig: ToolsRig, state: 'pending' | 'ambiguous' = 'pending') {
    await rig.call('install_deps', {});
    const [first] = await recordsOf(rig);
    await rig.store.sideEffects.intend({
      idempotencyKey: `${BASE}:2`,
      type: 'install_deps',
      target: first?.target ?? rig.worktree,
      attemptId: ATTEMPT_ID,
      params: first?.params ?? {},
    });
    if (state === 'ambiguous') {
      await rig.store.sideEffects.resolve(`${BASE}:2`, { state: 'ambiguous', verifier: null });
    }
  }

  it('is settled by the verifier and run again (open_command rerun_safe, the default)', async () => {
    const rig = await installRig();
    await leaveOpen(rig);
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 0, reused: false });
    expect(await runsOf(rig)).toBe(2);
    const states = Object.fromEntries(
      (await recordsOf(rig)).map((record) => [record.idempotencyKey, record.state]),
    );
    expect(states).toEqual({
      [`${BASE}:1`]: 'done',
      [`${BASE}:2`]: 'not_done',
      [`${BASE}:2~2`]: 'done',
    });
  });

  it('answers ambiguous and runs nothing when open_command is ask', async () => {
    const rig = await installRig('  effects:\n    open_command: ask\n');
    await leaveOpen(rig);
    // Under `ask` the record carries no "safe to rerun" mark, so the verifier cannot settle it.
    const failure = await rig.fail('install_deps', {});
    expect(failure.code).toBe('ambiguous');
    expect(await runsOf(rig)).toBe(1);
    const open = await openEffectsOf(rig.store.sideEffects, ATTEMPT_ID);
    expect(open.map((effect) => effect.key)).toEqual([`${BASE}:2`]);
    expect(open[0]?.state).toBe('ambiguous');
    // Asked again, it stays ambiguous and still runs nothing.
    expect((await rig.fail('install_deps', {})).code).toBe('ambiguous');
    expect(await runsOf(rig)).toBe(1);
  });
});

describeWithLauncher('restricted_shell and run_tests', () => {
  it('records a shell command and answers an open one of the same argv as ambiguous', async () => {
    const rig = await rigOf();
    const argv = ['ls'];
    expect(await rig.call('restricted_shell', { argv })).toMatchObject({ exitCode: 0 });
    const [first] = await recordsOf(rig, 'restricted_shell');
    expect(first).toMatchObject({ idempotencyKey: `${SHELL_BASE}:1`, state: 'done' });
    // What the model typed is not in the params.
    expect(JSON.stringify(first?.params)).not.toContain('ls -');

    // Another run of the same argv is a new step: a shell command is never replayed.
    expect(await rig.call('restricted_shell', { argv })).toMatchObject({ exitCode: 0 });
    expect(await recordsOf(rig, 'restricted_shell')).toHaveLength(2);

    await rig.store.sideEffects.intend({
      idempotencyKey: `${SHELL_BASE}:3`,
      type: 'restricted_shell',
      target: first?.target ?? rig.worktree,
      attemptId: ATTEMPT_ID,
      params: first?.params ?? {},
    });
    const failure = await rig.fail('restricted_shell', { argv });
    expect(failure.code).toBe('ambiguous');
    // Another argv is another call: it is not blocked.
    expect(await rig.call('restricted_shell', { argv: ['ls', '-a'] })).toMatchObject({
      exitCode: 0,
    });
  });

  it('runs run_tests again every time, recording each run', async () => {
    const rig = await rigOf({ tools: '  commands:\n    test: [node, t.js]' });
    await rig.write('t.js', "require('node:fs').appendFileSync('runs.log', 'x');");
    await rig.call('run_tests', {});
    await rig.call('run_tests', {});
    expect(await runsOf(rig)).toBe(2);
    expect((await recordsOf(rig, 'run_tests')).map((record) => record.state)).toEqual([
      'done',
      'done',
    ]);
  });

  it('keeps two identical calls in flight apart: two steps, no collision', async () => {
    const rig = await rigOf();
    await rig.write('slow.js', 'setTimeout(() => console.log("done"), 300);');
    const [a, b] = await Promise.all([
      rig.call('restricted_shell', { argv: ['node', 'slow.js'] }),
      rig.call('restricted_shell', { argv: ['node', 'slow.js'] }),
    ]);
    expect(a).toMatchObject({ exitCode: 0 });
    expect(b).toMatchObject({ exitCode: 0 });
    expect((await recordsOf(rig, 'restricted_shell')).map((record) => record.state)).toEqual([
      'done',
      'done',
    ]);
  });
});

describeWithLauncher('effectsOf', () => {
  it('lists what was done, apart from what is open or failed', async () => {
    const rig = await installRig();
    await rig.write('package.json', '{"v":1}');
    await rig.call('install_deps', {});
    await rig.call('restricted_shell', { argv: ['ls'] });
    await rig.store.sideEffects.intend({
      idempotencyKey: `${BASE}:2`,
      type: 'install_deps',
      target: rig.worktree,
      attemptId: ATTEMPT_ID,
    });
    const done = await effectsOf(rig.store.sideEffects, ATTEMPT_ID);
    expect(done.map((effect) => [effect.type, effect.step, effect.state])).toEqual([
      ['install_deps', 1, 'done'],
      ['restricted_shell', 1, 'done'],
    ]);
    const onlyInstall = await effectsOf(rig.store.sideEffects, ATTEMPT_ID, ['install_deps']);
    expect(onlyInstall).toHaveLength(1);
    expect((await openEffectsOf(rig.store.sideEffects, ATTEMPT_ID)).map((e) => e.key)).toEqual([
      `${BASE}:2`,
    ]);
    expect(await effectsOf(rig.store.sideEffects, 'p1/other/1')).toEqual([]);
  });
});
