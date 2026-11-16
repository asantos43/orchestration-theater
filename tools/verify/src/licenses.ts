// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import semver from 'semver';
import { compareStrings, toPosix, type CheckResult, type Finding } from './common.js';
import type { PackageException, Policy } from './policy.js';
import type { LeveledPackage, Level } from './pnpm.js';
import { buildRules, classifyLicense, verdictRank } from './spdx.js';

export type Situation =
  'allowed' | 'accepted' | 'exception' | 'undecided' | 'forbidden' | 'bundled-external-tool';

export interface LicenseItem {
  name: string;
  version: string;
  level: Level;
  license: string;
  situation: Situation;
  reason: string | undefined;
  /** Package location relative to the repository root (never absolute). */
  location: string;
  decision: { decidedBy: string; date: string; source: string } | undefined;
}

export interface LicenseReport {
  total: number;
  byLevel: Record<Level, number>;
  byLicense: Record<string, number>;
  bySituation: Record<Situation, number>;
  items: LicenseItem[];
}

const FAILING: ReadonlySet<Situation> = new Set([
  'undecided',
  'forbidden',
  'bundled-external-tool',
]);

function findException(
  exceptions: readonly PackageException[],
  pkg: LeveledPackage,
): PackageException | undefined {
  return exceptions.find((x) => {
    if (x.package !== pkg.name) return false;
    if (x.versions !== undefined && !semver.satisfies(pkg.version, x.versions)) return false;
    if (x.license !== undefined && x.license !== pkg.license) return false;
    const scope = pkg.level === 'B' ? 'production' : 'development';
    return x.scope === 'any' || x.scope === scope;
  });
}

export function buildLicenseReport(
  packages: readonly LeveledPackage[],
  policy: Policy,
  root: string,
): LicenseReport {
  const rules = buildRules(policy);
  const externalTools = new Map(policy.externalTools.map((t) => [t.package, t]));
  const items: LicenseItem[] = [];
  for (const pkg of packages) {
    const classification = classifyLicense(pkg.license, rules);
    let situation: Situation = classification.verdict;
    let reason = classification.reason;
    let decision: LicenseItem['decision'];
    if (verdictRank(classification.verdict) >= verdictRank('undecided')) {
      const exception = findException(policy.packageExceptions, pkg);
      if (
        exception !== undefined &&
        (classification.verdict !== 'forbidden' || exception.allowForbidden)
      ) {
        situation = 'exception';
        reason = `package exception: ${exception.reason} (${exception.date})`;
        decision = {
          decidedBy: exception.decidedBy,
          date: exception.date,
          source: exception.source,
        };
      }
    }
    const tool = externalTools.get(pkg.name);
    if (tool !== undefined && pkg.level === 'B') {
      situation = 'bundled-external-tool';
      reason = `${pkg.name} is an external tool (level C, ${tool.date}): the executable must not bundle or load it`;
    }
    items.push({
      name: pkg.name,
      version: pkg.version,
      level: pkg.level,
      license: pkg.license,
      situation,
      reason,
      location: toPosix(path.relative(root, pkg.path)),
      decision,
    });
  }
  items.sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version));
  const bySituation: Record<Situation, number> = {
    allowed: 0,
    accepted: 0,
    exception: 0,
    undecided: 0,
    forbidden: 0,
    'bundled-external-tool': 0,
  };
  const byLicense: Record<string, number> = {};
  const byLevel: Record<Level, number> = { B: 0, D: 0 };
  for (const item of items) {
    bySituation[item.situation]++;
    byLevel[item.level]++;
    byLicense[item.license] = (byLicense[item.license] ?? 0) + 1;
  }
  return { total: items.length, byLevel, byLicense, bySituation, items };
}

export function licenseResult(report: LicenseReport): CheckResult {
  const findings: Finding[] = [];
  if (report.total === 0) {
    findings.push({
      severity: 'error',
      subject: 'dependency tree',
      message:
        'no third-party packages found: the installed tree was not read (run "pnpm install" first). Approving zero packages would hide a broken check',
    });
  }
  for (const item of report.items) {
    if (!FAILING.has(item.situation)) continue;
    findings.push({
      severity: 'error',
      subject: `${item.name}@${item.version}`,
      message: `${item.situation} (level ${item.level}, license "${item.license}"): ${item.reason ?? ''} [${item.location}]`,
    });
  }
  const licenses = Object.entries(report.byLicense)
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .map(([license, count]) => `${license}=${String(count)}`)
    .join(', ');
  const s = report.bySituation;
  return {
    summary: [
      `packages: ${String(report.total)} (level B, bundled: ${String(report.byLevel.B)}; level D, development only: ${String(report.byLevel.D)})`,
      `allowed: ${String(s.allowed)} | accepted in dependencies: ${String(s.accepted)} | package exceptions: ${String(s.exception)} | undecided: ${String(s.undecided)} | forbidden: ${String(s.forbidden)} | bundled external tools: ${String(s['bundled-external-tool'])}`,
      `licenses: ${licenses === '' ? '(none)' : licenses}`,
    ],
    findings,
  };
}
