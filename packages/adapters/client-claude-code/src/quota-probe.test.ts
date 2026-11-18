// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterUnavailable, type ProfileRef, type QuotaReading } from '@otheater/core';
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
} from './fixtures/quota.js';
import { ClaudeQuotaProbe } from './quota-probe.js';
import { STATUSLINE_QUOTA_FILE } from './quota-statusline.js';

const REF: ProfileRef = { client: 'claude-code', profile: 'p' };

describe('ClaudeQuotaProbe', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ot-claude-probe-'));
    dir = join(root, 'profile');
    await mkdir(dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const probe = (watchEveryMs?: number): ClaudeQuotaProbe =>
    new ClaudeQuotaProbe({
      profileDir: () => dir,
      clock: { now: () => NOW },
      ...(watchEveryMs === undefined ? {} : { watchEveryMs }),
    });
  const put = (body: unknown): Promise<void> =>
    writeFile(join(dir, STATUSLINE_QUOTA_FILE), JSON.stringify(body));

  it('implements the QuotaProbe port and names the client', () => {
    expect(probe().id).toBe('claude-code');
    expect(probe().implements.port).toBe('QuotaProbe');
  });

  it('declares the two windows the statusline gives, both ways and approximate', () => {
    expect(probe().capabilities()).toEqual({
      windows: ['5h', '7d'],
      delivery: 'both',
      precision: 'approximate',
    });
  });

  it('reads the fixture of the statusline into windows with their reset', async () => {
    await put(QUOTA_FILE_BOTH);
    const reading = await probe().read(REF);
    expect(reading).toEqual({
      observedAt: NOW - 60_000,
      windows: [
        { window: '5h', usedPercent: 37, resetsAt: FIVE_HOUR_RESET_S * 1000 },
        { window: '7d', usedPercent: 12, resetsAt: SEVEN_DAY_RESET_S * 1000 },
      ],
    });
  });

  it('reads only the window still open after the other one reset', async () => {
    await put(QUOTA_FILE_FIVE_HOUR_OVER);
    const reading = await probe().read(REF);
    expect(reading.windows.map((w) => w.window)).toEqual(['7d']);
  });

  it('rejects with AdapterUnavailable when the statusline has not written yet', async () => {
    await expect(probe().read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('rejects a file with no rate_limits, so the profile stays unknown', async () => {
    await put(QUOTA_FILE_NO_LIMITS);
    const error = await probe()
      .read(REF)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as Error).message).toContain('no rate_limits');
  });

  it('refuses a value outside 0..100 and says why', async () => {
    await put(QUOTA_FILE_OUT_OF_RANGE);
    const error = await probe()
      .read(REF)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as Error).message).toMatch(/five_hour.*140.*above 100/);
  });

  it('does not read a quota file that is a link to somewhere else', async () => {
    const elsewhere = join(root, 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(QUOTA_FILE_BOTH));
    await symlink(elsewhere, join(dir, STATUSLINE_QUOTA_FILE));
    await expect(probe().read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('rejects when no profile directory resolver was given', async () => {
    const bare = new ClaudeQuotaProbe();
    await expect(bare.read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(() => bare.watch(REF, () => undefined)).toThrow(AdapterUnavailable);
  });

  it('holds a reading from the future back to the clock', async () => {
    await put(
      quotaFile({ five_hour: { used_percentage: 5, resets_at: FIVE_HOUR_RESET_S } }, NOW + 9e6),
    );
    expect((await probe().read(REF)).observedAt).toBe(NOW);
  });

  describe('watch', () => {
    const until = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(condition()).toBe(true);
    };

    it('delivers a reading when the command writes one, once per new observation', async () => {
      const seen: QuotaReading[] = [];
      const handle = probe(10).watch(REF, (reading) => seen.push(reading));
      try {
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toEqual([]);
        await put(QUOTA_FILE_BOTH);
        await until(() => seen.length === 1);
        await new Promise((r) => setTimeout(r, 60));
        expect(seen).toHaveLength(1);
        await put(quotaFile(QUOTA_FILE_BOTH.rate_limits, NOW - 30_000));
        await until(() => seen.length === 2);
        expect(seen[1]?.observedAt).toBe(NOW - 30_000);
      } finally {
        handle.dispose();
      }
    });

    it('stops delivering after dispose', async () => {
      const seen: QuotaReading[] = [];
      const handle = probe(10).watch(REF, (reading) => seen.push(reading));
      handle.dispose();
      await put(QUOTA_FILE_BOTH);
      await new Promise((r) => setTimeout(r, 80));
      expect(seen).toEqual([]);
    });

    it('does not deliver a file it cannot use, and keeps watching', async () => {
      const seen: QuotaReading[] = [];
      const handle = probe(10).watch(REF, (reading) => seen.push(reading));
      try {
        await put(QUOTA_FILE_OUT_OF_RANGE);
        await new Promise((r) => setTimeout(r, 60));
        expect(seen).toEqual([]);
        await put(QUOTA_FILE_BOTH);
        await until(() => seen.length === 1);
      } finally {
        handle.dispose();
      }
    });
  });
});
