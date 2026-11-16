// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPolicy, type Policy } from './policy.js';

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const POLICY_FILE = path.join(REPOSITORY_ROOT, 'tools', 'verify', 'policy.json');

/** The real lists (allowed, forbidden, ...) without any decision: tests of the mechanism start from here. */
export function bareRealPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...loadPolicy(POLICY_FILE),
    acceptedInDependencies: [],
    packageExceptions: [],
    externalTools: [],
    credentialAllowlist: [],
    ...overrides,
  };
}

export const DECISION = { decidedBy: 'test', date: '2026-11-15', reason: 'test', source: 'test' };

/** Temporary directories created by a test, removed by `cleanupTemp`. */
const created: string[] = [];

export function makeTemp(prefix = 'otheater-verify-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
