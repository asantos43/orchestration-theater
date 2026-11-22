// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateStaging } from './staging.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function staging(): Promise<UpdateStaging> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-staging-'));
  dirs.push(dir);
  return new UpdateStaging(join(dir, 'staging'));
}

async function store(s: UpdateStaging, version: string, bytes = 'exe'): Promise<void> {
  const partial = await s.partialPath();
  await writeFile(partial, bytes);
  await s.commit({
    version,
    channel: 'stable',
    platform: 'linux-x64',
    asset: {
      platform: 'linux-x64',
      kind: 'exe',
      name: `ot-${version}`,
      size: bytes.length,
      sha256: 'c'.repeat(64),
    },
    partial,
    manifest: Buffer.from('{}'),
    signature: 'sig',
    storedAt: 1,
  });
}

describe('the staging folder', () => {
  it('keeps a checked download with its manifest and signature, and nothing else', async () => {
    const s = await staging();
    await store(s, '1.0.0');
    expect(await readdir(s.dir)).toEqual(['1.0.0']);
    expect((await readdir(join(s.dir, '1.0.0'))).sort()).toEqual([
      'manifest.json',
      'manifest.json.sig',
      'ot-1.0.0',
      'ready.json',
    ]);
    const ready = await s.ready();
    expect(ready).toMatchObject({ version: '1.0.0', platform: 'linux-x64' });
    if (process.platform !== 'win32') {
      expect((await stat(ready?.file ?? '')).mode & 0o777).toBe(0o700);
    }
  });

  it('a newer version replaces the older', async () => {
    const s = await staging();
    await store(s, '1.0.0');
    await store(s, '1.1.0');
    expect(await readdir(s.dir)).toEqual(['1.1.0']);
    expect((await s.ready())?.version).toBe('1.1.0');
  });

  it('a damaged version is not offered', async () => {
    const s = await staging();
    await store(s, '1.0.0', 'exe');
    await writeFile(join(s.dir, '1.0.0', 'ot-1.0.0'), 'cut-short');
    expect(await s.ready()).toBeUndefined();
    await mkdir(join(s.dir, '2.0.0'));
    expect(await s.ready()).toBeUndefined();
  });

  it('discard and sweep remove what was not finished, and only that', async () => {
    const s = await staging();
    await store(s, '1.0.0');
    const partial = await s.partialPath();
    await writeFile(partial, 'half');
    await s.discard(partial);
    await s.discard(partial);
    await writeFile(await s.partialPath(), 'left');
    await mkdir(join(s.dir, '.incoming-x'));
    await s.sweep();
    expect(await readdir(s.dir)).toEqual(['1.0.0']);
    expect(await readFile(join(s.dir, '1.0.0', 'ot-1.0.0'), 'utf8')).toBe('exe');
  });

  it('a folder that does not exist is empty', async () => {
    const s = await staging();
    expect(await s.ready()).toBeUndefined();
    await s.sweep();
  });
});
