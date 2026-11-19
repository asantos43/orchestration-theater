// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conventionsToJson,
  ProjectConventionsSchema,
  type LaunchOptions,
  type ProcessLauncher,
} from '@otheater/core';
import { InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultLauncher, defaultVcs } from '../compose.js';
import {
  makeToolsRig,
  realClock,
  type ToolsRig,
  type ToolsRigOptions,
} from '../tools/tools-fixture.js';
import { applyConventionAnswers } from './confirm.js';
import { detectConventions } from './detect.js';
import { describeWithLauncher } from '../launcher-fixture.js';

let root: string;
const rigs: ToolsRig[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-conv-tools-')));
});

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
  await rm(root, { recursive: true, force: true });
});

/** The real launcher, but every command is recorded and replaced by an `echo` of its words. */
function recordingLauncher(seen: LaunchOptions[]): ProcessLauncher {
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  return {
    ...real,
    capabilities: () => real.capabilities(),
    launch: (opts: LaunchOptions) => {
      seen.push(opts);
      return real.launch({ ...opts, cmd: 'echo', args: [opts.cmd, ...opts.args] });
    },
  };
}

async function rigOf(options: ToolsRigOptions): Promise<ToolsRig> {
  const rig = await makeToolsRig(options, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  rigs.push(rig);
  return rig;
}

function wordsOf(seen: readonly LaunchOptions[]): string[][] {
  return seen.map((launch) => [launch.cmd, ...launch.args]);
}

/** An imported repository whose files say "pnpm test". */
async function pnpmRepository(): Promise<string> {
  const repo = join(root, 'imported');
  await mkdir(repo);
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'imported', scripts: { test: 'vitest run' } }),
  );
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return repo;
}

describeWithLauncher('the conventions are what run_tests and install_deps run', () => {
  it('runs the test command detected in the repository (pnpm test)', async () => {
    const detected = await detectConventions({ vcs: defaultVcs(), repo: await pnpmRepository() });
    expect(detected.commands).toEqual({ test: 'pnpm test', install: 'pnpm install' });

    const seen: LaunchOptions[] = [];
    const rig = await rigOf({
      launcher: recordingLauncher(seen),
      conventions: conventionsToJson(detected),
    });
    expect(await rig.call('run_tests', {})).toMatchObject({ exitCode: 0, stdout: 'pnpm test\n' });
    expect(await rig.call('install_deps', {})).toMatchObject({
      exitCode: 0,
      stdout: 'pnpm install\n',
    });
    expect(wordsOf(seen)).toEqual([
      ['pnpm', 'test'],
      ['pnpm', 'install'],
    ]);
  });

  it('runs the command the Producer typed instead of the detected one', async () => {
    const detected = await detectConventions({ vcs: defaultVcs(), repo: await pnpmRepository() });
    const answered = applyConventionAnswers(detected, ['', '', 'pnpm run test:ci', '']);
    expect(answered.commands.test).toBe('pnpm run test:ci');

    const seen: LaunchOptions[] = [];
    const rig = await rigOf({
      launcher: recordingLauncher(seen),
      conventions: conventionsToJson(answered),
    });
    await rig.call('run_tests', {});
    expect(wordsOf(seen)).toEqual([['pnpm', 'run', 'test:ci']]);
  });

  it('keeps the precedence: override of the scenario, then conventions, then the global config', async () => {
    const detected = await detectConventions({ vcs: defaultVcs(), repo: await pnpmRepository() });
    const global = '  commands:\n    test: [echo, global]';

    const seen: LaunchOptions[] = [];
    const overridden = await rigOf({
      launcher: recordingLauncher(seen),
      tools: global,
      conventions: conventionsToJson(detected),
      configOverride: { tools: { commands: { test: ['make', 'check'] } } },
    });
    await overridden.call('run_tests', {});
    const withConventions = await rigOf({
      launcher: recordingLauncher(seen),
      tools: global,
      conventions: conventionsToJson(detected),
    });
    await withConventions.call('run_tests', {});
    const globalOnly = await rigOf({ launcher: recordingLauncher(seen), tools: global });
    await globalOnly.call('run_tests', {});

    expect(wordsOf(seen)).toEqual([
      ['make', 'check'],
      ['pnpm', 'test'],
      ['echo', 'global'],
    ]);
  });
});

describeWithLauncher('ProjectConventionsSchema is the one shape of the commands', () => {
  it('accepts a command as a line or as an argv, and the tools read both', async () => {
    const detected = await detectConventions({ vcs: defaultVcs(), repo: await pnpmRepository() });
    const argvForm = { ...detected, commands: { test: ['cargo', 'test'], install: 'cargo fetch' } };
    expect(ProjectConventionsSchema.safeParse(argvForm).success).toBe(true);
    expect(
      ProjectConventionsSchema.safeParse({ ...detected, commands: { test: [] } }).success,
    ).toBe(false);

    const seen: LaunchOptions[] = [];
    const rig = await rigOf({
      launcher: recordingLauncher(seen),
      conventions: conventionsToJson(argvForm),
    });
    await rig.call('run_tests', {});
    await rig.call('install_deps', {});
    expect(wordsOf(seen)).toEqual([
      ['cargo', 'test'],
      ['cargo', 'fetch'],
    ]);
  });
});
