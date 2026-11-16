// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkNotices,
  gatherNoticePackages,
  renderNotices,
  type NoticePackage,
} from './notices.js';
import type { CopiedEntry } from './copied-code.js';
import { cleanupTemp, makeTemp, writeTree } from './test-helpers.js';
import { hasErrors } from './common.js';

afterAll(cleanupTemp);

function installed(root: string, name: string, files: Record<string, string>): string {
  const dir = path.join(root, 'node_modules', '.pnpm', `${name}@1.0.0`, 'node_modules', name);
  writeTree(dir, files);
  return dir;
}

describe('notices', () => {
  it('with no package or copied code the file still exists and says so', () => {
    const text = renderNotices([], []);
    expect(text).toContain('No third-party dependency is bundled yet.');
    expect(text).toContain('No third-party code has been copied');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('reads LICENSE, LICENCE and COPYING; NOTICE only for Apache-2.0; repository for MPL-2.0', () => {
    const root = makeTemp();
    const mit = installed(root, 'mit-pkg', { LICENSE: 'MIT text\r\n', 'package.json': '{}' });
    const apache = installed(root, 'apache-pkg', {
      'LICENCE.md': 'Apache text',
      NOTICE: 'Notice body\n',
      'package.json': '{}',
    });
    const mitWithNotice = installed(root, 'mit-notice', {
      COPYING: 'copying',
      NOTICE: 'not wanted',
      'package.json': '{}',
    });
    const mpl = installed(root, 'mpl-pkg', {
      LICENSE: 'MPL text',
      'package.json': JSON.stringify({
        repository: { type: 'git', url: 'git+https://example.org/mpl/pkg.git' },
      }),
    });
    const bare = installed(root, 'bare-pkg', { 'package.json': '{}' });
    const make = (
      name: string,
      license: string,
      dir: string,
    ): Parameters<typeof gatherNoticePackages>[0][number] => ({
      name,
      version: '1.0.0',
      license,
      path: dir,
      level: 'B',
    });
    const gathered = gatherNoticePackages([
      make('mit-pkg', 'MIT', mit),
      make('apache-pkg', 'Apache-2.0', apache),
      make('mit-notice', 'MIT', mitWithNotice),
      make('mpl-pkg', 'MPL-2.0', mpl),
      make('bare-pkg', 'ISC', bare),
      { ...make('dev-pkg', 'MIT', mit), level: 'D' },
    ]);
    expect(gathered.map((p) => p.name)).toEqual([
      'mit-pkg',
      'apache-pkg',
      'mit-notice',
      'mpl-pkg',
      'bare-pkg',
    ]);
    expect(gathered[0]?.licenseFiles).toEqual([{ fileName: 'LICENSE', text: 'MIT text' }]);
    expect(gathered[1]?.licenseFiles[0]?.fileName).toBe('LICENCE.md');
    expect(gathered[1]?.noticeFile?.text).toBe('Notice body');
    expect(gathered[2]?.noticeFile).toBeUndefined();
    expect(gathered[3]?.repository).toBe('https://example.org/mpl/pkg');

    const text = renderNotices(gathered, []);
    expect(text).toContain('### apache-pkg@1.0.0');
    expect(text).toContain('NOTICE (NOTICE):');
    expect(text).toContain('Source code (MPL-2.0): https://example.org/mpl/pkg');
    expect(text).toContain('No license file was found in the package');
    expect(text).not.toContain(root);
    expect(text).not.toContain('not wanted');
  });

  it('is deterministic: independent of input order, no dates', () => {
    const a: NoticePackage = {
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      repository: undefined,
      licenseFiles: [],
      noticeFile: undefined,
    };
    const b: NoticePackage = { ...a, name: 'b' };
    expect(renderNotices([b, a], [])).toBe(renderNotices([a, b], []));
    expect(renderNotices([a], [])).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it('lists copied code (level A) and fences texts that contain backticks', () => {
    const entry: CopiedEntry = {
      project: 'Claudexor',
      license: 'MIT',
      sourcePath: 'packages/x/y.ts',
      commit: 'abc1234',
      localFiles: ['packages/core/src/y.ts'],
      copyrightNotice: 'Copyright (c) Someone ``` tricky',
    };
    const text = renderNotices([], [entry]);
    expect(text).toContain('### Claudexor');
    expect(text).toContain('packages/x/y.ts at commit abc1234');
    expect(text).toContain('````text');
  });

  it('--check: fails when the file is missing or different, passes when equal', () => {
    const expected = renderNotices([], []);
    expect(hasErrors(checkNotices(expected, undefined, 'N.md'))).toBe(true);
    expect(hasErrors(checkNotices(expected, `${expected}x`, 'N.md'))).toBe(true);
    expect(hasErrors(checkNotices(expected, expected, 'N.md'))).toBe(false);
  });
});
