// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIVE_HOUR_RESET_S,
  NOW,
  QUOTA_FILE_BOTH,
  QUOTA_FILE_FIVE_HOUR_OVER,
  QUOTA_FILE_NO_LIMITS,
  QUOTA_FILE_OUT_OF_RANGE,
  quotaFile,
  SEVEN_DAY_RESET_S,
  STATUSLINE_STDIN,
  STATUSLINE_STDIN_NO_LIMITS,
} from './fixtures/quota.js';
import {
  isOurStatusline,
  parseStatuslineQuota,
  readStatuslineFile,
  STATUSLINE_QUOTA_FILE,
  STATUSLINE_QUOTA_MAX_BYTES,
  STATUSLINE_SCRIPT,
  STATUSLINE_SCRIPT_FILE,
  windowNameOf,
} from './quota-statusline.js';

const parse = (value: unknown, now = NOW): ReturnType<typeof parseStatuslineQuota> =>
  parseStatuslineQuota(JSON.stringify(value), now);

describe('parseStatuslineQuota', () => {
  it('turns both windows into a reading with their reset, and says the unit it saw', () => {
    const result = parse(QUOTA_FILE_BOTH);
    expect(result).toEqual({
      ok: true,
      unit: 'percent',
      reading: {
        observedAt: NOW - 60_000,
        windows: [
          { window: '5h', usedPercent: 37, resetsAt: FIVE_HOUR_RESET_S * 1000 },
          { window: '7d', usedPercent: 12, resetsAt: SEVEN_DAY_RESET_S * 1000 },
        ],
      },
    });
  });

  it('keeps a decimal percentage as it came (the documentation gives 23.5)', () => {
    const result = parse(
      quotaFile({ five_hour: { used_percentage: 23.5, resets_at: FIVE_HOUR_RESET_S } }),
    );
    expect(result).toMatchObject({ ok: true, reading: { windows: [{ usedPercent: 23.5 }] } });
  });

  it('accepts the two ends of the range: 0 and 100', () => {
    const result = parse(
      quotaFile({
        five_hour: { used_percentage: 0, resets_at: FIVE_HOUR_RESET_S },
        seven_day: { used_percentage: 100, resets_at: SEVEN_DAY_RESET_S },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      reading: { windows: [{ usedPercent: 0 }, { usedPercent: 100 }] },
    });
  });

  it('does not take a small number for a fraction: used_percentage 1 is 1%, not 100%', () => {
    const result = parse(
      quotaFile({ five_hour: { used_percentage: 1, resets_at: FIVE_HOUR_RESET_S } }),
    );
    expect(result).toMatchObject({ ok: true, reading: { windows: [{ usedPercent: 1 }] } });
  });

  it('drops a window whose reset has passed, as Claude Code does', () => {
    const result = parse(QUOTA_FILE_FIVE_HOUR_OVER);
    expect(result).toMatchObject({
      ok: true,
      reading: { windows: [{ window: '7d', usedPercent: 12 }] },
    });
  });

  it('refuses a file with no window still open, with the reason', () => {
    const result = parse(QUOTA_FILE_BOTH, NOW + 10 * 86_400_000);
    expect(result).toEqual({
      ok: false,
      reason: 'the quota file has no window that is still open',
    });
  });

  it('refuses a file with no rate_limits, so the profile stays unknown', () => {
    expect(parse(QUOTA_FILE_NO_LIMITS)).toEqual({
      ok: false,
      reason: 'the quota file has no rate_limits',
    });
    expect(parse(quotaFile(null))).toMatchObject({ ok: false });
    expect(parse(quotaFile({}))).toMatchObject({ ok: false });
  });

  it('refuses a value outside 0..100 with the reason, and never clamps it', () => {
    const result = parse(QUOTA_FILE_OUT_OF_RANGE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rate_limits.five_hour.used_percentage');
      expect(result.reason).toContain('140');
      expect(result.reason).toContain('above 100');
    }
    const negative = parse(
      quotaFile({ seven_day: { used_percentage: -3, resets_at: SEVEN_DAY_RESET_S } }),
    );
    expect(negative).toMatchObject({ ok: false });
    if (!negative.ok) expect(negative.reason).toContain('below 0');
  });

  it.each([
    ['a string', '37'],
    ['null', null],
    ['a missing number', undefined],
  ])('refuses a used_percentage that is %s', (_name, value) => {
    const result = parse(
      quotaFile({ five_hour: { used_percentage: value, resets_at: FIVE_HOUR_RESET_S } }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('not a finite number');
  });

  it('refuses a resets_at that is not a time', () => {
    const result = parse(quotaFile({ five_hour: { used_percentage: 5, resets_at: 'soon' } }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('resets_at');
  });

  it('holds a reading from the future back to now', () => {
    const result = parse(
      quotaFile(
        { five_hour: { used_percentage: 5, resets_at: FIVE_HOUR_RESET_S } },
        NOW + 3_600_000,
      ),
    );
    expect(result).toMatchObject({ ok: true, reading: { observedAt: NOW } });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[1]'],
    ['an unknown version', JSON.stringify({ ...QUOTA_FILE_BOTH, version: 99 })],
    ['no observed_at', JSON.stringify({ version: 1, rate_limits: {} })],
  ])('refuses %s', (_name, text) => {
    expect(parseStatuslineQuota(text, NOW)).toMatchObject({ ok: false });
  });
});

describe('windowNameOf and isOurStatusline', () => {
  it('names the windows as the daemon does and lets another name through', () => {
    expect(windowNameOf('five_hour')).toBe('5h');
    expect(windowNameOf('seven_day')).toBe('7d');
    expect(windowNameOf('seven_day_opus')).toBe('seven_day_opus');
    expect(windowNameOf('toString')).toBe('toString');
  });

  it('knows a statusLine that names our script', () => {
    expect(isOurStatusline({ type: 'command', command: `node ${STATUSLINE_SCRIPT_FILE}` })).toBe(
      true,
    );
    expect(isOurStatusline({ type: 'command', command: 'echo hi' })).toBe(false);
    expect(isOurStatusline('echo hi')).toBe(false);
    expect(isOurStatusline(undefined)).toBe(false);
  });
});

describe('readStatuslineFile', () => {
  let root: string;
  let profileDir: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ot-claude-quota-'));
    profileDir = join(root, 'profile');
    outside = join(root, 'outside');
    await mkdir(profileDir);
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const file = (): string => join(profileDir, STATUSLINE_QUOTA_FILE);

  it('reads the file of the profile', async () => {
    await writeFile(file(), JSON.stringify(QUOTA_FILE_BOTH));
    expect(JSON.parse(await readStatuslineFile(profileDir))).toEqual(QUOTA_FILE_BOTH);
  });

  it('rejects with AdapterUnavailable when the statusline has not written yet', async () => {
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
    await expect(readStatuslineFile(join(root, 'no-such-dir'))).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
  });

  it('does not follow a symbolic link that points out of the profile', async () => {
    const secret = join(outside, 'elsewhere.json');
    await writeFile(secret, JSON.stringify(QUOTA_FILE_BOTH));
    await symlink(secret, file());
    const error = await readStatuslineFile(profileDir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as Error).message).toContain('symbolic link');
  });

  it('does not follow a symbolic link that points inside the profile either', async () => {
    await writeFile(join(profileDir, 'real.json'), JSON.stringify(QUOTA_FILE_BOTH));
    await symlink(join(profileDir, 'real.json'), file());
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('does not read through a dangling symbolic link', async () => {
    await symlink(join(outside, 'not-there.json'), file());
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('does not read a hard link to a file outside the profile', async () => {
    const elsewhere = join(outside, 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(QUOTA_FILE_BOTH));
    await link(elsewhere, file());
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('does not read a directory, or a file too big to be ours', async () => {
    await mkdir(file());
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
    await rm(file(), { recursive: true });
    await writeFile(file(), ' '.repeat(STATUSLINE_QUOTA_MAX_BYTES + 1));
    await expect(readStatuslineFile(profileDir)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('reads when the profile directory itself is a link (the operator chose it)', async () => {
    await writeFile(join(outside, STATUSLINE_QUOTA_FILE), JSON.stringify(QUOTA_FILE_BOTH));
    const linked = join(root, 'linked-profile');
    await symlink(outside, linked);
    expect(JSON.parse(await readStatuslineFile(linked))).toEqual(QUOTA_FILE_BOTH);
  });
});

describe('the statusline command (STATUSLINE_SCRIPT), run for real with node on a sample input', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ot-claude-statusline-'));
    await writeFile(join(dir, STATUSLINE_SCRIPT_FILE), STATUSLINE_SCRIPT);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(input: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [join(dir, STATUSLINE_SCRIPT_FILE)], {
      input,
      encoding: 'utf8',
      timeout: 20_000,
      // An empty environment: the command needs nothing from it, and must not need the network.
      env: {},
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function written(): Promise<unknown> {
    return JSON.parse(await readFile(join(dir, STATUSLINE_QUOTA_FILE), 'utf8'));
  }

  it('keeps the two windows and nothing else of the input, and prints nothing', async () => {
    const result = run(JSON.stringify(STATUSLINE_STDIN));
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    const body = (await written()) as Record<string, unknown>;
    expect(body).toEqual({
      version: 1,
      observed_at: expect.any(Number) as number,
      rate_limits: {
        five_hour: { used_percentage: 37, resets_at: FIVE_HOUR_RESET_S },
        seven_day: { used_percentage: 12, resets_at: SEVEN_DAY_RESET_S },
      },
    });
    const text = await readFile(join(dir, STATUSLINE_QUOTA_FILE), 'utf8');
    for (const leaked of ['session-0000', 'transcript', '/example', 'claude-example', 'cost']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('writes only the script and the quota file in the directory, with no temporary left', async () => {
    run(JSON.stringify(STATUSLINE_STDIN));
    expect((await readdir(dir)).sort()).toEqual([STATUSLINE_QUOTA_FILE, STATUSLINE_SCRIPT_FILE]);
  });

  it('does not replace a reading with a blank: no rate_limits, null, garbage and oversize leave the file', async () => {
    run(JSON.stringify(STATUSLINE_STDIN));
    const before = await readFile(join(dir, STATUSLINE_QUOTA_FILE), 'utf8');
    for (const input of [
      JSON.stringify(STATUSLINE_STDIN_NO_LIMITS),
      JSON.stringify({ model: 'x' }),
      JSON.stringify({ rate_limits: {} }),
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 'a lot' } } }),
      'not json at all',
      '',
      ' '.repeat(1_048_577),
    ]) {
      expect(run(input)).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(await readFile(join(dir, STATUSLINE_QUOTA_FILE), 'utf8')).toBe(before);
    }
  });

  it('writes nothing when the first call has no rate_limits and there is no file yet', async () => {
    run(JSON.stringify(STATUSLINE_STDIN_NO_LIMITS));
    expect(await readdir(dir)).toEqual([STATUSLINE_SCRIPT_FILE]);
  });

  it('keeps an out-of-range number as it came, so the probe can refuse it with the reason', async () => {
    run(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 140, resets_at: 5 } } }));
    expect(await written()).toMatchObject({
      rate_limits: { five_hour: { used_percentage: 140, resets_at: 5 } },
    });
  });

  it('replaces a symbolic link in the place of the file instead of writing through it', async () => {
    const target = join(dir, 'victim.txt');
    await writeFile(target, 'untouched');
    await symlink(target, join(dir, STATUSLINE_QUOTA_FILE));
    run(JSON.stringify(STATUSLINE_STDIN));
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect(await written()).toMatchObject({ version: 1 });
  });

  it('has no way to reach the network, a model or another process', () => {
    const imports = [...STATUSLINE_SCRIPT.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['node:fs', 'node:path', 'node:url']);
    for (const word of [
      'fetch',
      'http',
      'net.',
      'child_process',
      'spawn',
      'exec',
      'readFile',
      'process.env',
    ]) {
      expect(STATUSLINE_SCRIPT).not.toContain(word);
    }
  });
});
