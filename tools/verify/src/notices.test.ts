// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bundledPackageIds,
  checkNotices,
  checkPlatformNotices,
  gatherNoticePackages,
  gatherPlatformNotices,
  installedSelection,
  listedPackageIds,
  noticesFileName,
  platformGraph,
  renderNotices,
  selectBundled,
  type NoticePackage,
} from './notices.js';
import { parseLockfile, PLATFORM_IDS, type PlatformId } from './lockfile.js';
import type { InstalledPackage } from './pnpm.js';
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

  it('--check: only warns about a difference off the generating platform, still fails when missing', () => {
    const expected = renderNotices([], []);
    const off = checkNotices(expected, `${expected}x`, 'N.md', 'win32');
    expect(hasErrors(off)).toBe(false);
    expect(off.findings.map((f) => f.severity)).toEqual(['warning']);
    expect(hasErrors(checkNotices(expected, undefined, 'N.md', 'darwin'))).toBe(true);
    expect(checkNotices(expected, expected, 'N.md', 'win32').findings).toEqual([]);
  });
});

// ---------- per platform (P10) ----------

const LOCK = parseLockfile(`lockfileVersion: '9.0'

packages:

  '@n/keyring-darwin-arm64@2.0.0':
    cpu: [arm64]
    os: [darwin]

  '@n/keyring-linux-x64-gnu@2.0.0':
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  '@n/keyring-linux-x64-musl@2.0.0':
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@n/keyring-win32-x64-msvc@2.0.0':
    cpu: [x64]
    os: [win32]

snapshots:

  '@n/keyring@2.0.0':
    optionalDependencies:
      '@n/keyring-darwin-arm64': 2.0.0
      '@n/keyring-linux-x64-gnu': 2.0.0
      '@n/keyring-linux-x64-musl': 2.0.0
      '@n/keyring-win32-x64-msvc': 2.0.0
`);

const NATIVE_OF: Record<PlatformId, string> = {
  'linux-x64': '@n/keyring-linux-x64-gnu',
  'win32-x64': '@n/keyring-win32-x64-msvc',
  'darwin-arm64': '@n/keyring-darwin-arm64',
};

/** An installed tree as a Linux machine has it: the parent, a plain package and the Linux binary. */
function linuxTree(root: string): InstalledPackage[] {
  const make = (name: string, files: Record<string, string>): InstalledPackage => ({
    name,
    version: name.startsWith('@n/') ? '2.0.0' : '1.0.0',
    license: 'MIT',
    path: installed(root, name.replace('/', '_'), files),
  });
  return [
    make('@n/keyring', { LICENSE: 'Keyring MIT', 'package.json': '{}' }),
    make('@n/keyring-linux-x64-gnu', {
      'LICENSE.third-party.md': 'Rust crates of the Linux addon',
      'package.json': '{}',
    }),
    make('plain', { LICENSE: 'Plain MIT', 'package.json': '{}' }),
    make('unbundled', { LICENSE: 'Unbundled MIT', 'package.json': '{}' }),
  ];
}

describe('notices per platform', () => {
  it('the file of each platform is named after it', () => {
    expect(noticesFileName('win32-x64')).toBe('THIRD_PARTY_NOTICES-win32-x64.md');
    expect(PLATFORM_IDS.map(noticesFileName)).toEqual([
      'THIRD_PARTY_NOTICES-linux-x64.md',
      'THIRD_PARTY_NOTICES-win32-x64.md',
      'THIRD_PARTY_NOTICES-darwin-arm64.md',
    ]);
  });

  it('the graph of each platform has the binary of that platform and no other', () => {
    const prod = linuxTree(makeTemp());
    for (const platform of PLATFORM_IDS) {
      const entries = platformGraph(prod, LOCK, platform);
      const natives = entries.filter((e) => e.native).map((e) => e.name);
      expect(natives).toEqual([NATIVE_OF[platform]]);
      expect(entries.map((e) => e.name)).toContain('plain');
      expect(entries.map((e) => e.name)).not.toContain('@n/keyring-linux-x64-musl');
    }
    const linux = platformGraph(prod, LOCK, 'linux-x64').find((e) => e.native);
    expect(linux?.installed?.name).toBe('@n/keyring-linux-x64-gnu');
    const win = platformGraph(prod, LOCK, 'win32-x64').find((e) => e.native);
    expect(win?.installed).toBeUndefined();
    expect(win?.parent?.name).toBe('@n/keyring');
  });

  it('a binary package that is not installed takes the license and the text of the package that declares it', () => {
    const prod = linuxTree(makeTemp());
    const win = gatherPlatformNotices(platformGraph(prod, LOCK, 'win32-x64'));
    const native = win.find((p) => p.name === '@n/keyring-win32-x64-msvc');
    expect(native?.derivedFrom).toBe('@n/keyring@2.0.0');
    expect(native?.licenseFiles.map((f) => f.text)).toEqual(['Keyring MIT']);
    const linux = gatherPlatformNotices(platformGraph(prod, LOCK, 'linux-x64'));
    const own = linux.find((p) => p.name === '@n/keyring-linux-x64-gnu');
    expect(own?.derivedFrom).toBeUndefined();
    expect(own?.licenseFiles[0]?.text).toBe('Rust crates of the Linux addon');
    const text = renderNotices(win, [], { platform: 'win32-x64', basis: 'bundle' });
    expect(text).toContain('Not installed on the machine that generated this file');
    expect(text).toContain('# Third-party notices (win32-x64)');
    expect(text).not.toContain('Rust crates of the Linux addon');
  });

  it('reads the bundled packages from the paths of the metafile, whatever the peers suffix', () => {
    const inputs = {
      'node_modules/.pnpm/ink@8.0.0_@types+react@19.3.0_react@19.3.1/node_modules/ink/build/ink.js':
        {},
      'node_modules/.pnpm/@scope+pkg@1.2.3-rc.1/node_modules/@scope/pkg/index.js': {},
      'node_modules\\.pnpm\\chalk@6.0.1\\node_modules\\chalk\\index.js': {},
      'node_modules/hoisted/index.js': {},
      'packages/daemon/dist/cli.js': {},
      // A store folder pnpm shortened (60 characters on Windows): the version is cut.
      'node_modules/.pnpm/@agentclientprotocol+sdk@2._abcdefghijklmnopqrstuvwxyz/node_modules/@agentclientprotocol/sdk/dist/index.js':
        {},
    };
    expect([...bundledPackageIds({ inputs })].sort()).toEqual([
      '@agentclientprotocol/sdk@*',
      '@scope/pkg@1.2.3-rc.1',
      'chalk@6.0.1',
      'hoisted@*',
      'ink@8.0.0',
    ]);
    expect(bundledPackageIds({})).toEqual(new Set());
  });

  it('crosses the graph with the bundle: what was bundled plus the binary, and flags a bundled stranger', () => {
    const prod = linuxTree(makeTemp());
    const graph = platformGraph(prod, LOCK, 'darwin-arm64');
    const { selected, unknown } = selectBundled(
      graph,
      prod,
      new Set(['plain@1.0.0', '@n/keyring@2.0.0', 'stranger@9.9.9']),
    );
    expect(selected.map((e) => `${e.name}@${e.version}`)).toEqual([
      '@n/keyring@2.0.0',
      '@n/keyring-darwin-arm64@2.0.0',
      'plain@1.0.0',
    ]);
    expect(unknown).toEqual(['stranger@9.9.9']);
  });

  it('on the machine own platform the installed tree and the graph give the same packages', () => {
    const prod = linuxTree(makeTemp());
    const bundled = new Set(['plain@1.0.0', '@n/keyring@2.0.0']);
    const graph = selectBundled(platformGraph(prod, LOCK, 'linux-x64'), prod, bundled).selected;
    expect(graph.map((e) => `${e.name}@${e.version}`).sort()).toEqual(
      installedSelection(prod, LOCK, bundled).sort(),
    );
  });

  function rendered(platform: PlatformId, drop?: string): { text: string; ids: string[] } {
    const prod = linuxTree(makeTemp());
    const bundled = new Set(['plain@1.0.0', '@n/keyring@2.0.0']);
    const selected = selectBundled(platformGraph(prod, LOCK, platform), prod, bundled).selected;
    const ids = selected.map((e) => `${e.name}@${e.version}`);
    const packages = gatherPlatformNotices(selected).filter(
      (p) => `${p.name}@${p.version}` !== drop,
    );
    const extraSections =
      platform === 'win32-x64'
        ? [{ title: 'Windows job launcher (native/job-launcher)', text: 'crates' }]
        : [];
    return { text: renderNotices(packages, [], { platform, basis: 'bundle', extraSections }), ids };
  }

  const check = (
    platform: PlatformId,
    text: string | undefined,
    ids: string[],
  ): ReturnType<typeof checkPlatformNotices> =>
    checkPlatformNotices({ platform, expectedIds: ids, onDisk: text, fileName: 'N.md' });

  it('the check passes on a file that has exactly the packages of the graph', () => {
    for (const platform of PLATFORM_IDS) {
      const { text, ids } = rendered(platform);
      const result = check(platform, text, ids);
      expect(result.findings).toEqual([]);
      expect(result.summary[0]).toContain(`${String(ids.length)} package(s)`);
    }
  });

  it('the check FAILS when a package is missing from the file', () => {
    const { text, ids } = rendered('linux-x64', 'plain@1.0.0');
    const result = check('linux-x64', text, ids);
    expect(hasErrors(result)).toBe(true);
    expect(result.findings.map((f) => f.message)).toContain(
      'package missing from the file: plain@1.0.0',
    );
  });

  it('the check fails when the binary of another platform is in the file, or the one of the platform is not', () => {
    const win = rendered('win32-x64');
    const wrong = check(
      'linux-x64',
      win.text.replace('(win32-x64)', '(linux-x64)'),
      rendered('linux-x64').ids,
    );
    const messages = wrong.findings.map((f) => f.message);
    expect(messages).toContain('package missing from the file: @n/keyring-linux-x64-gnu@2.0.0');
    expect(messages).toContain(
      'package not in the graph of linux-x64: @n/keyring-win32-x64-msvc@2.0.0',
    );
    expect(messages.some((m) => m.startsWith('section of another platform'))).toBe(true);
  });

  it('the check fails on a build tool, on a duplicate, on the wrong platform title and on a file that is not there', () => {
    const { text, ids } = rendered('linux-x64');
    const tool = text.replace(
      '## Copied code (level A)',
      '### esbuild@0.28.2\n\n- License: MIT\n\n## Copied code (level A)',
    );
    const withTool = check('linux-x64', tool, ids);
    expect(withTool.findings.map((f) => f.message)).toContain(
      'esbuild@0.28.2 is a build tool (level D) and must not be in the notices',
    );
    const twice = text.replace(
      '## Copied code (level A)',
      '### plain@1.0.0\n\n## Copied code (level A)',
    );
    expect(check('linux-x64', twice, ids).findings.map((f) => f.message)).toContain(
      'a package is listed more than once',
    );
    expect(hasErrors(check('darwin-arm64', text, ids))).toBe(true);
    expect(hasErrors(check('linux-x64', undefined, ids))).toBe(true);
  });

  it('the Windows file carries the launcher notices and the others do not', () => {
    const win = rendered('win32-x64');
    expect(win.text).toContain('## Windows job launcher (native/job-launcher)');
    const noLauncher = win.text.replace(/## Windows job launcher[\s\S]*$/, '');
    expect(check('win32-x64', noLauncher, win.ids).findings.map((f) => f.message)).toContain(
      'section missing: Windows job launcher (native/job-launcher)',
    );
    expect(rendered('linux-x64').text).not.toContain('Windows job launcher');
  });

  it('a heading inside a license text is not a package', () => {
    const pkg: NoticePackage = {
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      repository: undefined,
      licenseFiles: [{ fileName: 'LICENSE', text: '### fake@9.9.9\n## Copied code (level A)' }],
      noticeFile: undefined,
    };
    const text = renderNotices([pkg], [], { platform: 'linux-x64' });
    expect(listedPackageIds(text)).toEqual(['a@1.0.0']);
  });

  it('the check tells the installed tree from the lockfile graph, and a stale file', () => {
    const { text, ids } = rendered('linux-x64');
    const base = {
      platform: 'linux-x64' as const,
      expectedIds: ids,
      onDisk: text,
      fileName: 'N.md',
    };
    expect(checkPlatformNotices({ ...base, installedIds: ids, rendered: text }).findings).toEqual(
      [],
    );
    const missing = checkPlatformNotices({ ...base, installedIds: [...ids, 'ghost@1.0.0'] });
    expect(missing.findings.map((f) => f.message)).toContain(
      'is installed here but the graph of linux-x64 (from the lockfile) lacks it',
    );
    expect(
      hasErrors(checkPlatformNotices({ ...base, installedIds: ids, rendered: `${text}x` })),
    ).toBe(true);
    const unknown = checkPlatformNotices({ ...base, unknownBundled: ['stranger@9.9.9'] });
    expect(hasErrors(unknown)).toBe(true);
  });
});
