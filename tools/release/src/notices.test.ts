// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noticesArgs, noticesFileName, writeNotices } from './notices.js';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'otheater-notices-'));
  temps.push(dir);
  return dir;
}

describe('release notices', () => {
  it('the file of each platform is named after it', () => {
    expect(noticesFileName('linux-x64')).toBe('THIRD_PARTY_NOTICES-linux-x64.md');
    expect(noticesFileName('win32-x64')).toBe('THIRD_PARTY_NOTICES-win32-x64.md');
    expect(noticesFileName('darwin-arm64')).toBe('THIRD_PARTY_NOTICES-darwin-arm64.md');
  });

  it('the arguments of tools/verify carry the platform, the metafile and the output', () => {
    expect(
      noticesArgs({ target: 'win32-x64', metafile: '/w/metafile.json', out: '/w/N.md' }),
    ).toEqual([
      'notices',
      '--platform',
      'win32-x64',
      '--metafile',
      '/w/metafile.json',
      '--out',
      '/w/N.md',
    ]);
  });

  it('per_platform generates the file and then checks it, both with the platform, the metafile and the root', () => {
    const root = temp();
    const workDir = path.join(root, 'dist', 'sea', 'win32-x64');
    mkdirSync(workDir, { recursive: true });
    const calls: string[][] = [];
    const out = writeNotices({
      root,
      target: 'win32-x64',
      mode: 'per_platform',
      workDir,
      run: (args, cwd) => {
        expect(cwd).toBe(root);
        calls.push([...args]);
      },
    });
    expect(out).toBe(path.join(workDir, 'THIRD_PARTY_NOTICES-win32-x64.md'));
    expect(calls).toHaveLength(2);
    const [generate, check] = calls;
    expect(generate?.slice(1, 8)).toEqual([
      'notices',
      '--platform',
      'win32-x64',
      '--metafile',
      path.join(workDir, 'metafile.json'),
      '--out',
      out,
    ]);
    expect(generate).toContain('--root');
    expect(generate).not.toContain('--check');
    expect(check).toContain('--check');
    expect(check?.slice(0, -1)).toEqual(generate);
  });

  it('a failing check stops the build (the error of the runner goes up)', () => {
    const root = temp();
    expect(() =>
      writeNotices({
        root,
        target: 'linux-x64',
        mode: 'per_platform',
        workDir: root,
        run: (args) => {
          if (args.includes('--check')) throw new Error('package missing from the file');
        },
      }),
    ).toThrow('package missing from the file');
  });

  it('root_only copies the root file under the name of the platform and runs nothing', () => {
    const root = temp();
    writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'root notices\n');
    const workDir = path.join(root, 'out');
    mkdirSync(workDir);
    const out = writeNotices({
      root,
      target: 'darwin-arm64',
      mode: 'root_only',
      workDir,
      run: () => {
        throw new Error('must not run');
      },
    });
    expect(path.basename(out)).toBe('THIRD_PARTY_NOTICES-darwin-arm64.md');
    expect(readFileSync(out, 'utf8')).toBe('root notices\n');
  });

  it('root_only without the root file is an error', () => {
    const root = temp();
    expect(() =>
      writeNotices({ root, target: 'linux-x64', mode: 'root_only', workDir: root }),
    ).toThrow('THIRD_PARTY_NOTICES.md not found');
  });
});
