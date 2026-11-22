// SPDX-License-Identifier: MPL-2.0
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildLicenseReport,
  licenseResult,
  type LicenseItem,
  type LicenseReport,
} from './licenses.js';
import { hasErrors } from './common.js';
import {
  collectPackages,
  parsePnpmLicenses,
  resolvePnpmCommand,
  type LeveledPackage,
} from './pnpm.js';
import { loadPolicy, type Policy } from './policy.js';
import {
  bareRealPolicy,
  cleanupTemp,
  DECISION,
  POLICY_FILE,
  REPOSITORY_ROOT,
} from './test-helpers.js';

afterAll(cleanupTemp);

const ROOT = '/repo';

function pkg(
  name: string,
  version: string,
  license: string,
  level: 'B' | 'D' = 'B',
): LeveledPackage {
  return {
    name,
    version,
    license,
    level,
    path: `${ROOT}/node_modules/.pnpm/${name}@${version}/node_modules/${name}`,
  };
}

function run(packages: LeveledPackage[], policy: Policy = bareRealPolicy()): LicenseReport {
  return buildLicenseReport(packages, policy, ROOT);
}

function find(report: LicenseReport, name: string): LicenseItem {
  const item = report.items.find((i) => i.name === name);
  if (item === undefined) throw new Error(`package ${name} not in the report`);
  return item;
}

describe('SPDX expressions', () => {
  it('approves only allowed licenses', () => {
    const report = run([
      pkg('a', '1.0.0', 'MIT'),
      pkg('b', '1.0.0', 'Apache-2.0'),
      pkg('c', '1.0.0', 'MPL-2.0'),
    ]);
    expect(hasErrors(licenseResult(report))).toBe(false);
    expect(find(report, 'b').situation).toBe('allowed');
  });

  it('GPL, AGPL and LGPL fail, and the report says where the package is', () => {
    const report = run([
      pkg('b', '1.0.0', 'GPL-3.0-only'),
      pkg('c', '1.0.0', 'AGPL-3.0-or-later'),
      pkg('d', '1.0.0', 'LGPL-2.1-or-later'),
      pkg('e', '1.0.0', 'GPL-2.0+'),
    ]);
    expect(report.bySituation.forbidden).toBe(4);
    const result = licenseResult(report);
    expect(result.findings).toHaveLength(4);
    expect(result.findings[0]?.message).toContain('node_modules/.pnpm/b@1.0.0');
    expect(result.findings.map((f) => f.message).join('\n')).not.toContain('/repo/');
  });

  it('OR takes the best branch, AND the worst', () => {
    const report = run([
      pkg('or', '1.0.0', '(MIT OR GPL-3.0-only)'),
      pkg('and', '1.0.0', 'MIT AND LGPL-2.1-or-later'),
      pkg('or2', '1.0.0', '(GPL-2.0-only OR AGPL-3.0-only)'),
      pkg('mixed', '1.0.0', '(MIT AND ISC) OR GPL-3.0-only'),
    ]);
    expect(find(report, 'or').situation).toBe('allowed');
    expect(find(report, 'and').situation).toBe('forbidden');
    expect(find(report, 'or2').situation).toBe('forbidden');
    expect(find(report, 'mixed').situation).toBe('allowed');
  });

  it('WITH evaluates the base license', () => {
    const report = run([
      pkg('w1', '1.0.0', 'GPL-2.0-only WITH Classpath-exception-2.0'),
      pkg('w2', '1.0.0', 'Apache-2.0 WITH LLVM-exception'),
    ]);
    expect(find(report, 'w1').situation).toBe('forbidden');
    expect(find(report, 'w2').situation).toBe('allowed');
  });

  it('missing, unknown, SEE LICENSE and non-SPDX licenses have no decision and fail', () => {
    const report = run([
      pkg('u', '1.0.0', 'Unlicense'),
      pkg('x', '1.0.0', ''),
      pkg('unk', '1.0.0', 'Unknown'),
      pkg('see', '1.0.0', 'SEE LICENSE IN LICENSE.md'),
      pkg('inv', '1.0.0', 'Some License 3'),
    ]);
    for (const name of ['u', 'x', 'unk', 'see', 'inv'])
      expect(find(report, name).situation).toBe('undecided');
    expect(licenseResult(report).findings).toHaveLength(5);
  });
});

describe('decisions', () => {
  it('a license decision applies to the whole tree, in B and D', () => {
    const policy = bareRealPolicy({
      acceptedInDependencies: [{ license: 'BlueOak-1.0.0', ...DECISION }],
    });
    const report = run(
      [pkg('bo', '1.0.0', 'BlueOak-1.0.0'), pkg('bo2', '1.0.0', 'BlueOak-1.0.0', 'D')],
      policy,
    );
    expect(find(report, 'bo').situation).toBe('accepted');
    expect(find(report, 'bo2').situation).toBe('accepted');
  });

  it('a license decision never opens a forbidden license', () => {
    const policy = bareRealPolicy({
      acceptedInDependencies: [{ license: 'GPL-3.0-only', ...DECISION }],
    });
    expect(find(run([pkg('g', '1.0.0', 'GPL-3.0-only')], policy), 'g').situation).toBe('forbidden');
  });

  it('a package exception respects name, version range, exact license and scope', () => {
    const exception = (extra: Partial<Policy['packageExceptions'][number]> = {}): Policy =>
      bareRealPolicy({
        packageExceptions: [
          {
            package: 'custom',
            versions: '>=1.0.0 <2.0.0',
            license: 'SEE LICENSE IN LICENSE.md',
            scope: 'production',
            allowForbidden: false,
            ...DECISION,
            ...extra,
          },
        ],
      });
    const tree = [pkg('custom', '1.2.0', 'SEE LICENSE IN LICENSE.md')];
    const ok = run(tree, exception());
    expect(find(ok, 'custom').situation).toBe('exception');
    expect(find(ok, 'custom').decision?.decidedBy).toBe('test');
    expect(hasErrors(licenseResult(ok))).toBe(false);
    const rejected: [string, Partial<Policy['packageExceptions'][number]>][] = [
      ['version outside the range', { versions: '>=2.0.0' }],
      ['different license text', { license: 'MIT' }],
      ['development scope', { scope: 'development' }],
      ['another package', { package: 'other' }],
    ];
    for (const [label, extra] of rejected) {
      expect(find(run(tree, exception(extra)), 'custom').situation, label).toBe('undecided');
    }
  });

  it('an exception for a forbidden license needs allowForbidden', () => {
    const base = {
      package: 'g',
      versions: undefined,
      license: undefined,
      scope: 'any' as const,
      ...DECISION,
    };
    const without = bareRealPolicy({ packageExceptions: [{ ...base, allowForbidden: false }] });
    const withFlag = bareRealPolicy({ packageExceptions: [{ ...base, allowForbidden: true }] });
    const tree = [pkg('g', '1.0.0', 'LGPL-2.1-or-later')];
    expect(find(run(tree, without), 'g').situation).toBe('forbidden');
    expect(find(run(tree, withFlag), 'g').situation).toBe('exception');
  });

  it('level C: an external tool bundled at level B fails, in D it does not', () => {
    const policy = bareRealPolicy({ externalTools: [{ package: 'cli', ...DECISION }] });
    const bundled = run([pkg('cli', '1.0.0', 'MIT', 'B'), pkg('app', '1.0.0', 'MIT')], policy);
    expect(find(bundled, 'cli').situation).toBe('bundled-external-tool');
    expect(licenseResult(bundled).findings).toHaveLength(1);
    const devOnly = run([pkg('cli', '1.0.0', 'MIT', 'D')], policy);
    expect(hasErrors(licenseResult(devOnly))).toBe(false);
  });
});

describe('totals and report', () => {
  it('zero third-party packages fails: an empty read is not an approval', () => {
    const result = licenseResult(run([]));
    expect(hasErrors(result)).toBe(true);
    expect(result.findings[0]?.message).toContain('no third-party packages');
  });

  it('zero production packages with development packages is allowed', () => {
    const report = run([pkg('dev', '1.0.0', 'MIT', 'D')]);
    expect(report.byLevel).toEqual({ B: 0, D: 1 });
    expect(hasErrors(licenseResult(report))).toBe(false);
  });

  it('counts by license and level, sorted', () => {
    const report = run([
      pkg('z', '1.0.0', 'MIT'),
      pkg('a', '1.0.0', 'MIT', 'D'),
      pkg('m', '2.0.0', 'ISC', 'D'),
      pkg('m', '1.0.0', 'ISC', 'D'),
    ]);
    expect(report.byLicense).toEqual({ MIT: 2, ISC: 2 });
    expect(report.items.map((i) => `${i.name}@${i.version}`)).toEqual([
      'a@1.0.0',
      'm@1.0.0',
      'm@2.0.0',
      'z@1.0.0',
    ]);
    expect(licenseResult(report).summary[0]).toContain('level B, bundled: 1');
  });
});

describe('the real policy', () => {
  it('accepts the eight N45 licenses and keeps GPL forbidden', () => {
    const licenses = [
      'BlueOak-1.0.0',
      'Unlicense',
      'CC0-1.0',
      'MIT-0',
      'Python-2.0',
      'WTFPL',
      'CC-BY-3.0',
      'CC-BY-4.0',
    ];
    const report = run(
      [
        ...licenses.map((l, i) => pkg(`l${String(i)}`, '1.0.0', l)),
        pkg('g', '1.0.0', 'GPL-3.0-only'),
      ],
      loadPolicy(POLICY_FILE),
    );
    expect(report.items.filter((i) => i.situation === 'accepted')).toHaveLength(8);
    expect(report.items.filter((i) => i.situation === 'forbidden').map((i) => i.name)).toEqual([
      'g',
    ]);
  });

  it('the AgentPrism exception applies to 1.0.0 and not to another version', () => {
    const policy = loadPolicy(POLICY_FILE);
    const report = run(
      [
        pkg('@evilmartians/agent-prism-data', '1.0.0', 'Unknown'),
        pkg('@evilmartians/agent-prism-types', '1.0.1', 'Unknown'),
      ],
      policy,
    );
    expect(find(report, '@evilmartians/agent-prism-data').situation).toBe('exception');
    expect(find(report, '@evilmartians/agent-prism-types').situation).toBe('undecided');
  });

  it('every decision records who, when, why and where', () => {
    const policy = loadPolicy(POLICY_FILE);
    const decisions = [
      ...policy.acceptedInDependencies,
      ...policy.packageExceptions,
      ...policy.externalTools,
    ];
    expect(decisions.length).toBeGreaterThan(10);
    for (const d of decisions) {
      expect([d.decidedBy, d.date, d.reason, d.source].every((v) => v !== '')).toBe(true);
    }
  });
});

describe('pnpm output', () => {
  const sample = JSON.stringify({
    MIT: [
      { name: 'a', versions: ['1.0.0', '2.0.0'], paths: ['/x/a1', '/x/a2'], license: 'MIT' },
      { name: '@s/b', versions: ['3.0.0'], paths: ['/x/b'], license: 'MIT' },
    ],
  });

  it('pairs each version with its path', () => {
    expect(parsePnpmLicenses(sample).map((p) => `${p.name}@${p.version}=${p.path}`)).toEqual([
      'a@1.0.0=/x/a1',
      'a@2.0.0=/x/a2',
      '@s/b@3.0.0=/x/b',
    ]);
  });

  it('an empty tree is the plain pnpm sentence, not JSON', () => {
    expect(parsePnpmLicenses('No licenses in packages found\n')).toEqual([]);
  });

  it('rejects an unexpected format (exit code 2 upstream)', () => {
    expect(() => parsePnpmLicenses('hello')).toThrow(/not JSON/);
    expect(() => parsePnpmLicenses('[]')).toThrow(/not an object/);
    expect(() =>
      parsePnpmLicenses(JSON.stringify({ MIT: [{ name: 'a', versions: ['1'], paths: [] }] })),
    ).toThrow(/different lengths/);
    expect(() => parsePnpmLicenses(JSON.stringify({ MIT: [{ versions: [], paths: [] }] }))).toThrow(
      /"name"/,
    );
  });

  it('a package in production and in development counts as B; uses the injected exec', async () => {
    const calls: string[][] = [];
    const exec = (_file: string, args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      const prod = args.includes('--prod');
      return Promise.resolve(
        JSON.stringify({
          MIT: [
            { name: 'both', versions: ['1.0.0'], paths: ['/p/both'], license: 'MIT' },
            ...(prod
              ? []
              : [{ name: 'devonly', versions: ['1.0.0'], paths: ['/p/dev'], license: 'MIT' }]),
          ],
        }),
      );
    };
    const packages = await collectPackages(exec, REPOSITORY_ROOT, { file: 'pnpm', prefix: [] });
    expect(packages.find((p) => p.name === 'both')?.level).toBe('B');
    expect(packages.find((p) => p.name === 'devonly')?.level).toBe('D');
    expect(calls).toEqual([
      ['licenses', 'list', '--json', '--prod'],
      ['licenses', 'list', '--json', '--dev'],
    ]);
  });

  it('starts pnpm through npm_execpath when available (works on Windows too)', () => {
    expect(resolvePnpmCommand({ npm_execpath: '/usr/lib/pnpm/bin/pnpm.cjs' }, '/node')).toEqual({
      file: '/node',
      prefix: ['/usr/lib/pnpm/bin/pnpm.cjs'],
    });
    expect(resolvePnpmCommand({ npm_execpath: '/opt/pnpm/pnpm' }, '/node')).toEqual({
      file: '/opt/pnpm/pnpm',
      prefix: [],
    });
    expect(resolvePnpmCommand({}, '/node', 'linux')).toEqual({ file: 'pnpm', prefix: [] });
    expect(resolvePnpmCommand({}, 'node.exe', 'win32')).toEqual({
      file: 'cmd.exe',
      prefix: ['/d', '/s', '/c', 'pnpm'],
    });
    expect(
      resolvePnpmCommand({ npm_execpath: '/usr/lib/npm/bin/npm-cli.js' }, '/node', 'linux'),
    ).toEqual({
      file: 'pnpm',
      prefix: [],
    });
  });
});
