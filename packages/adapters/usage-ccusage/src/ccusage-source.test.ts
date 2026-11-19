// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterUnavailable, InvalidInput } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CCUSAGE_PINNED_VERSION, CcusageSource, findOnPath, versionOf } from './index.js';
import {
  dailyJson,
  fakeCalls,
  reconfigureFakeCcusage,
  writeFakeCcusage,
} from './testing/fake-ccusage.js';

let root: string;
let binDir: string;
let homeDir: string;
let profileDir: string;

beforeEach(() => {
  // The real path: on macOS the temp folder is a link (/var -> /private/var) and the child sees the real one.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ot-ccusage-')));
  binDir = join(root, 'bin');
  homeDir = join(root, 'adapter-home');
  profileDir = join(root, 'profile');
  // A Claude profile that ran a session has `projects/`; without it the adapter reads nothing.
  mkdirSync(join(profileDir, 'projects'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const OUT = dailyJson([
  { date: '2026-11-17', models: [{ name: 'm', input: 10, output: 5, cost: 0.25 }] },
]);

function source(bin: string, extra: Partial<ConstructorParameters<typeof CcusageSource>[0]> = {}) {
  return new CcusageSource({ command: bin, homeDir, env: { PATH: process.env.PATH }, ...extra });
}

describe('CcusageSource.check', () => {
  it('is ok with the pinned version', async () => {
    const bin = writeFakeCcusage(binDir, { version: CCUSAGE_PINNED_VERSION });
    expect(await source(bin).check()).toEqual({ ok: true, version: CCUSAGE_PINNED_VERSION });
  });

  it('reads the version out of a longer line', async () => {
    const bin = writeFakeCcusage(binDir, { version: `ccusage v${CCUSAGE_PINNED_VERSION}` });
    expect((await source(bin).check()).ok).toBe(true);
  });

  it('is wrong_version for another version, naming both', async () => {
    const bin = writeFakeCcusage(binDir, { version: '20.0.49' });
    const status = await source(bin).check();
    expect(status.ok).toBe(false);
    if (!status.ok) {
      expect(status.reason).toBe('wrong_version');
      expect(status.detail).toContain('20.0.49');
      expect(status.detail).toContain(CCUSAGE_PINNED_VERSION);
    }
  });

  it('is not_found when the executable is missing', async () => {
    const status = await source(join(root, 'nowhere', 'ccusage')).check();
    expect(status).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('is failed when the tool does not say a version', async () => {
    const bin = writeFakeCcusage(binDir, { version: 'no numbers here' });
    expect(await source(bin).check()).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('runs --version with no variable of the user and no client directory of the user', async () => {
    const bin = writeFakeCcusage(binDir, { version: CCUSAGE_PINNED_VERSION });
    await source(bin).check();
    const [call] = fakeCalls(binDir);
    expect(call?.argv).toEqual(['--version']);
    expect(call?.cwd).toBe(homeDir);
    expect(call?.env.HOME).toBe(homeDir);
    expect(call?.env.CLAUDE_CONFIG_DIR?.startsWith(homeDir)).toBe(true);
    expect(call?.env.CODEX_HOME?.startsWith(homeDir)).toBe(true);
    expect(call?.env.OPENCODE_DATA_DIR?.startsWith(homeDir)).toBe(true);
  });
});

describe('CcusageSource.read', () => {
  it('points CLAUDE_CONFIG_DIR at the profile and everything else at the adapter home', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
    });
    const entries = await source(bin).read({
      clientId: 'claude-code',
      profileDir,
      sinceDay: '2026-11-10',
      untilDay: '2026-11-18',
    });
    expect(entries).toEqual([
      {
        day: '2026-11-17',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.25,
      },
    ]);
    const calls = fakeCalls(binDir);
    const run = calls[calls.length - 1];
    expect(run?.argv).toEqual([
      'claude',
      'daily',
      '--json',
      '--timezone',
      'UTC',
      '--offline',
      '--since',
      '2026-11-10',
      '--until',
      '2026-11-18',
    ]);
    expect(run?.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(run?.env.HOME).toBe(homeDir);
    expect(run?.env.CODEX_HOME?.startsWith(homeDir)).toBe(true);
    expect(run?.env.OPENCODE_DATA_DIR?.startsWith(homeDir)).toBe(true);
  });

  it('points CODEX_HOME at the profile for codex', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { codex: OUT },
    });
    await source(bin).read({ clientId: 'codex', profileDir });
    const calls = fakeCalls(binDir);
    const run = calls[calls.length - 1];
    expect(run?.argv.slice(0, 2)).toEqual(['codex', 'daily']);
    expect(run?.env.CODEX_HOME).toBe(profileDir);
    expect(run?.env.CLAUDE_CONFIG_DIR?.startsWith(homeDir)).toBe(true);
  });

  it('points the XDG folders and OPENCODE_DATA_DIR into the profile for opencode', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { opencode: OUT },
    });
    await source(bin).read({ clientId: 'opencode', profileDir });
    const calls = fakeCalls(binDir);
    const run = calls[calls.length - 1];
    expect(run?.env.XDG_DATA_HOME).toBe(join(profileDir, 'data'));
    expect(run?.env.OPENCODE_DATA_DIR).toBe(join(profileDir, 'data', 'opencode'));
    expect(run?.env.HOME).toBe(homeDir);
  });

  it('does not pass --offline when pricing is online', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
    });
    await source(bin, { pricing: 'online' }).read({ clientId: 'claude-code', profileDir });
    const calls = fakeCalls(binDir);
    expect(calls[calls.length - 1]?.argv).not.toContain('--offline');
  });

  it('checks the version once, before the first read, and refuses a wrong one', async () => {
    const bin = writeFakeCcusage(binDir, { version: '1.2.3', outputs: { claude: OUT } });
    await expect(source(bin).read({ clientId: 'claude-code', profileDir })).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    expect(fakeCalls(binDir).every((call) => call.argv[0] === '--version')).toBe(true);
  });

  it('does not check the version again after a good check', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
    });
    const s = source(bin);
    await s.read({ clientId: 'claude-code', profileDir });
    await s.read({ clientId: 'claude-code', profileDir });
    expect(fakeCalls(binDir).filter((call) => call.argv[0] === '--version')).toHaveLength(1);
  });

  it('rejects when the executable is gone', async () => {
    await expect(
      source(join(root, 'nowhere', 'ccusage')).read({ clientId: 'claude-code', profileDir }),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('puts neither stdout nor stderr of a failing run in the error', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      exitCode: 3,
      stderr: 'secret conversation text',
      outputs: { claude: 'secret words' },
    });
    const error = await source(bin)
      .read({ clientId: 'claude-code', profileDir })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect(String(error)).toContain('exit code 3');
    expect(String(error)).not.toContain('secret');
  });

  it('rejects output that is not understood, without echoing it', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: 'secret words' },
    });
    const error = await source(bin)
      .read({ clientId: 'claude-code', profileDir })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect(String(error)).not.toContain('secret');
  });

  it('gives up after the timeout', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
      sleepMs: 5000,
    });
    await expect(
      source(bin, { timeoutMs: 300 }).read({ clientId: 'claude-code', profileDir }),
    ).rejects.toThrow(/did not answer/);
  });

  it('reads nothing, and runs nothing, for a Claude profile with no projects folder', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
    });
    const empty = join(root, 'never-ran');
    mkdirSync(empty, { recursive: true });
    expect(await source(bin).read({ clientId: 'claude-code', profileDir: empty })).toEqual([]);
    expect(fakeCalls(binDir).filter((call) => call.argv[0] === 'claude')).toEqual([]);
  });

  it('refuses a bad query before running anything', async () => {
    const bin = writeFakeCcusage(binDir, {
      version: CCUSAGE_PINNED_VERSION,
      outputs: { claude: OUT },
    });
    const s = source(bin);
    await expect(s.read({ clientId: 'gemini', profileDir })).rejects.toBeInstanceOf(InvalidInput);
    await expect(
      s.read({ clientId: 'claude-code', profileDir: 'relative/dir' }),
    ).rejects.toBeInstanceOf(InvalidInput);
    await expect(
      s.read({ clientId: 'claude-code', profileDir, sinceDay: '2026-13-01' }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(fakeCalls(binDir)).toEqual([]);
  });

  it('check can be repeated after the tool is fixed', async () => {
    const bin = writeFakeCcusage(binDir, { version: '1.0.0' });
    const s = source(bin);
    expect((await s.check()).ok).toBe(false);
    reconfigureFakeCcusage(binDir, { version: CCUSAGE_PINNED_VERSION });
    expect((await s.check()).ok).toBe(true);
  });
});

describe('command modes', () => {
  it('needs an absolute path in explicit mode', () => {
    expect(() => new CcusageSource({ command: 'ccusage', homeDir })).toThrow(InvalidInput);
  });

  it('needs a bare name in path mode', () => {
    expect(
      () => new CcusageSource({ command: '/usr/bin/ccusage', commandMode: 'path', homeDir }),
    ).toThrow(InvalidInput);
  });

  it('finds the tool on PATH only in path mode, and runs it by its absolute path', async () => {
    writeFakeCcusage(binDir, { version: CCUSAGE_PINNED_VERSION });
    const viaPath = new CcusageSource({
      command: 'ccusage',
      commandMode: 'path',
      homeDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    expect((await viaPath.check()).ok).toBe(true);
    const noPath = new CcusageSource({
      command: 'ccusage',
      commandMode: 'path',
      homeDir,
      env: { PATH: join(root, 'empty') },
    });
    expect(await noPath.check()).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('findOnPath skips relative folders and non-executables', () => {
    writeFakeCcusage(binDir, {});
    expect(findOnPath('ccusage', `relative:${binDir}`)).toBe(join(binDir, 'ccusage'));
    expect(findOnPath('fake-ccusage.json', binDir)).toBeUndefined();
    expect(findOnPath('ccusage', undefined)).toBeUndefined();
  });
});

describe('versionOf', () => {
  it('finds the first x.y.z', () => {
    expect(versionOf('20.0.48')).toBe('20.0.48');
    expect(versionOf('ccusage v20.0.48\n')).toBe('20.0.48');
    expect(versionOf('nothing')).toBeUndefined();
  });
});
