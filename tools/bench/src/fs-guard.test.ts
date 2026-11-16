// SPDX-License-Identifier: MPL-2.0
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRealDisk,
  checkDirectory,
  findMount,
  parseMounts,
  UnsafeDirectoryError,
} from './fs-guard.js';

const MOUNTS = [
  'sysfs /sys sysfs rw,nosuid 0 0',
  '/dev/nvme0n1p6 / btrfs rw,compress=zstd:1,ssd 0 0',
  '/dev/nvme0n1p6 /home btrfs rw,compress=zstd:1,ssd 0 0',
  'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
  'tmpfs /home/user/ramdisk tmpfs rw 0 0',
  '/dev/sdb1 /mnt/with\\040space ext4 rw 0 0',
  'tmpfs /run/user/1000 tmpfs rw 0 0',
].join('\n');

describe('parseMounts', () => {
  it('reads source, mount point, type and options, and unescapes octal sequences', () => {
    const mounts = parseMounts(MOUNTS);
    expect(mounts).toHaveLength(7);
    expect(mounts[1]).toEqual({
      source: '/dev/nvme0n1p6',
      mountPoint: '/',
      fsType: 'btrfs',
      options: ['rw', 'compress=zstd:1', 'ssd'],
    });
    expect(mounts[5]?.mountPoint).toBe('/mnt/with space');
  });

  it('skips blank and short lines', () => {
    expect(parseMounts('\n\nbroken line\n')).toEqual([]);
  });
});

describe('findMount', () => {
  const mounts = parseMounts(MOUNTS);

  it('takes the deepest mount point that contains the path', () => {
    expect(findMount(mounts, '/home/user/.cache/x')?.mountPoint).toBe('/home');
    expect(findMount(mounts, '/tmp/abc')?.fsType).toBe('tmpfs');
    expect(findMount(mounts, '/home/user/ramdisk/db')?.fsType).toBe('tmpfs');
  });

  it('matches on path boundaries, not on string prefixes', () => {
    expect(findMount(mounts, '/tmpfoo')?.mountPoint).toBe('/');
    expect(findMount(mounts, '/homework')?.mountPoint).toBe('/');
  });

  it('lets a later mount of the same point cover an earlier one', () => {
    const stacked = parseMounts('/dev/sda1 /data ext4 rw 0 0\ntmpfs /data tmpfs rw 0 0');
    expect(findMount(stacked, '/data/x')?.fsType).toBe('tmpfs');
  });
});

describe('assertRealDisk', () => {
  it('accepts a disk-backed filesystem and returns its mount', () => {
    expect(assertRealDisk('/home/user/.cache/bench', MOUNTS).fsType).toBe('btrfs');
  });

  it.each(['/tmp/bench', '/home/user/ramdisk/bench', '/run/user/1000/bench'])(
    'refuses %s (tmpfs)',
    (dir) => {
      expect(() => assertRealDisk(dir, MOUNTS)).toThrow(UnsafeDirectoryError);
      expect(() => assertRealDisk(dir, MOUNTS)).toThrow(/tmpfs/);
    },
  );

  it('refuses ramfs and devtmpfs too', () => {
    const text = 'ramfs /ram ramfs rw 0 0\ndevtmpfs /dev devtmpfs rw 0 0\n/dev/sda1 / ext4 rw 0 0';
    expect(() => assertRealDisk('/ram/x', text)).toThrow(/ramfs/);
    expect(() => assertRealDisk('/dev/x', text)).toThrow(/devtmpfs/);
  });

  it('refuses when no mount line matches (cannot tell)', () => {
    expect(() => assertRealDisk('/nowhere', 'sysfs /sys sysfs rw 0 0')).toThrow(
      UnsafeDirectoryError,
    );
  });

  it('refuses when statfs says RAM even if /proc/mounts looks like a disk', () => {
    expect(() => assertRealDisk('/home/user/x', MOUNTS, 0x01021994)).toThrow(/statfs/);
    expect(assertRealDisk('/home/user/x', MOUNTS, 0x9123683e).fsType).toBe('btrfs');
  });
});

describe('checkDirectory', () => {
  it('refuses a directory that /proc/mounts places on tmpfs (injected mounts)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otheater-bench-guard-'));
    try {
      const everythingIsTmpfs = (): Promise<string> => Promise.resolve('tmpfs / tmpfs rw 0 0');
      await expect(checkDirectory(dir, everythingIsTmpfs, 'linux')).rejects.toThrow(
        UnsafeDirectoryError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses before creating the folder', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'otheater-bench-guard-'));
    try {
      const target = join(parent, 'a', 'b');
      const everythingIsTmpfs = (): Promise<string> => Promise.resolve('tmpfs / tmpfs rw 0 0');
      await expect(checkDirectory(target, everythingIsTmpfs, 'linux')).rejects.toThrow(
        UnsafeDirectoryError,
      );
      await expect(access(target)).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses outside Linux without reading anything', async () => {
    const neverRead = (): Promise<string> => Promise.reject(new Error('must not be read'));
    await expect(checkDirectory('/nonexistent-bench-dir', neverRead, 'darwin')).rejects.toThrow(
      /only Linux/,
    );
  });
});
