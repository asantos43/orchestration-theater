// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, RolePolicy } from '@otheater/core';
import { PROFILE_SETTINGS_FILE, writeProfileSettings } from './prepare-profile.js';
import { STATUSLINE_QUOTA_FILE } from './quota-statusline.js';
import { sweepTemporaries, temporaryPathOf } from './temporaries.js';

const BRIDGE = Symbol.for('otheater.temporaries');
const COPIES = ['client-codex', 'client-opencode', 'vault-file'];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-adapter-temporaries-'));
});
afterEach(async () => {
  Reflect.deleteProperty(globalThis, BRIDGE);
  await rm(dir, { recursive: true, force: true });
});

/** The pid of a process that has already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

async function put(...names: string[]): Promise<void> {
  for (const name of names) await writeFile(join(dir, name), 'x');
}

async function listing(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('the copies of the helper', () => {
  it('are the same file in every adapter that keeps one', async () => {
    const mine = await readFile(new URL('./temporaries.ts', import.meta.url), 'utf8');
    for (const adapter of COPIES) {
      const url = new URL(`../../${adapter}/src/temporaries.ts`, import.meta.url);
      expect(await readFile(url, 'utf8'), adapter).toBe(mine);
    }
  });
});

describe('sweepTemporaries (the copy of the adapters)', () => {
  const target = (): string => join(dir, 'file.json');
  const shape = { hexLength: 8 } as const;

  it('removes the temporary of a dead pid, keeps a live pid, its own pid and every other name', async () => {
    const gone = deadPid();
    const orphan = `file.json.${String(gone)}.0123abcd.tmp`;
    const live = `file.json.${String(process.ppid)}.0123abcd.tmp`;
    const own = `file.json.${String(process.pid)}.0123abcd.tmp`;
    const outside = [
      `file.json.${String(gone)}.0123abc.tmp`,
      `file.json.${String(gone)}.tmp`,
      `.file.json.${String(gone)}.0123abcd.tmp`,
      `other.json.${String(gone)}.0123abcd.tmp`,
      `file.json.${String(gone)}.bak`,
    ];
    await put(orphan, live, own, ...outside);
    expect(await sweepTemporaries(target(), shape)).toEqual([orphan]);
    expect(await listing()).toEqual([live, own, ...outside].sort());
  });

  it('in age mode removes the old one and keeps the new one, whatever the pid says', async () => {
    const old = `file.json.${String(process.ppid)}.0123abcd.tmp`;
    const fresh = `file.json.${String(deadPid())}.0123abcd.tmp`;
    await put(old, fresh);
    const now = Date.now();
    await utimes(join(dir, old), new Date(now - 7_200_000), new Date(now - 7_200_000));
    const removed = await sweepTemporaries(target(), {
      ...shape,
      policy: { mode: 'age', maxAgeMs: 3_600_000 },
      now: () => now,
    });
    expect(removed).toEqual([old]);
    expect(await listing()).toEqual([fresh]);
  });

  it('with the cleaning off removes nothing, and a missing folder is not a failure', async () => {
    const orphan = `file.json.${String(deadPid())}.0123abcd.tmp`;
    await put(orphan);
    expect(await sweepTemporaries(target(), { ...shape, policy: { mode: 'off' } })).toEqual([]);
    const onError = vi.fn();
    expect(await sweepTemporaries(join(dir, 'none', 'f'), { ...shape, onError })).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(await listing()).toEqual([orphan]);
  });

  it('takes the policy and the sink of the client through the bridge', async () => {
    const orphan = `file.json.${String(deadPid())}.0123abcd.tmp`;
    await put(orphan);
    const report = vi.fn();
    (globalThis as Record<symbol, unknown>)[BRIDGE] = {
      version: 1,
      policy: () => ({ mode: 'off', maxAgeMs: 60_000 }),
      report,
    };
    expect(await sweepTemporaries(target(), shape)).toEqual([]);
    (globalThis as Record<symbol, unknown>)[BRIDGE] = {
      version: 1,
      policy: () => ({ mode: 'pid', maxAgeMs: 60_000 }),
      report,
    };
    // A folder that is a file cannot be read: the failure goes to the sink, and nothing throws.
    expect(await sweepTemporaries(join(dir, orphan, 'inner'), shape)).toEqual([]);
    expect(report).toHaveBeenCalledWith('inner', expect.anything());
    expect(await sweepTemporaries(target(), shape)).toEqual([orphan]);
  });

  it('ignores a bridge of another version and uses the default', async () => {
    const orphan = `file.json.${String(deadPid())}.0123abcd.tmp`;
    await put(orphan);
    (globalThis as Record<symbol, unknown>)[BRIDGE] = {
      version: 2,
      policy: () => ({ mode: 'off', maxAgeMs: 60_000 }),
      report: () => undefined,
    };
    expect(await sweepTemporaries(target(), shape)).toEqual([orphan]);
  });

  it('names a temporary with this pid, in the folder of the target', () => {
    const path = temporaryPathOf(target(), { hexLength: 16, hidden: true });
    expect(path.startsWith(dir)).toBe(true);
    expect(path.slice(dir.length + 1)).toMatch(
      new RegExp(`^\\.file\\.json\\.${String(process.pid)}\\.[0-9a-f]{16}\\.tmp$`, 'u'),
    );
  });
});

describe('writeProfileSettings and the orphan temporaries (N306)', () => {
  const policy: RolePolicy = {
    nativeTools: ['read'],
    nativeShell: 'none',
    mcpServers: [],
    mcpTools: {},
    onAsk: 'reject',
    bypass: 'forbidden',
    writeScope: 'worktree',
    network: { allow: [] },
  };

  it('removes the orphans of settings.json and of the quota file, and keeps the rest', async () => {
    const gone = deadPid();
    const settingsOrphan = `${PROFILE_SETTINGS_FILE}.${String(gone)}.0123abcd.tmp`;
    const quotaOrphan = `${STATUSLINE_QUOTA_FILE}.${String(gone)}.tmp`;
    const quotaLive = `${STATUSLINE_QUOTA_FILE}.${String(process.ppid)}.tmp`;
    await put(settingsOrphan, quotaOrphan, quotaLive, 'credentials.json');
    const profile: Profile = { client: 'claude-code', profile: 'p', id: 'claude-code/p', dir };
    await writeProfileSettings(profile, policy);
    const after = await listing();
    expect(after).not.toContain(settingsOrphan);
    expect(after).not.toContain(quotaOrphan);
    expect(after).toContain(quotaLive);
    expect(after).toContain('credentials.json');
    expect(after).toContain(PROFILE_SETTINGS_FILE);
    expect(after.filter((name) => name.endsWith('.tmp'))).toEqual([quotaLive]);
  });
});
