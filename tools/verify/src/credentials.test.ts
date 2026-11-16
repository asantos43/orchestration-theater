// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { checkCredentials, FORBIDDEN_PATTERNS, selectCredentialFiles } from './credentials.js';
import { bareRealPolicy, DECISION } from './test-helpers.js';

const policy = bareRealPolicy();

function scan(files: Record<string, string>, p = policy): ReturnType<typeof checkCredentials> {
  return checkCredentials(
    Object.entries(files).map(([path, content]) => ({ path, content })),
    p,
  );
}

describe('credential lock', () => {
  it('has the four patterns of architecture 6.3', () => {
    expect(FORBIDDEN_PATTERNS).toHaveLength(4);
  });

  it('reports every pattern with file and line, ignoring case, without echoing the line', () => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      const result = scan({
        'src/a.ts': `const secret = 'xyz';\nconst p = "${pattern.toUpperCase()}";\n`,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.subject).toBe('src/a.ts:2');
      expect(result.findings[0]?.message).not.toContain('xyz');
    }
  });

  it('does not flag lookalikes (lockfile, package.json, partial names)', () => {
    const result = scan({
      'package.json': '{ "name": "x", "dependencies": { "oauth-lib": "1.0.0" } }',
      'pnpm-lock.yaml': "'@scope/auth@1.0.0':\n  resolution: {integrity: sha512-abc}\n",
      'src/a.ts': "import { api } from './api/oauth.js'; // credentials.ts, auth/json",
    });
    expect(result.findings).toEqual([]);
  });

  it('skips spikes/ and docs/ when selecting files', () => {
    expect(
      selectCredentialFiles(
        ['a.ts', 'spikes/x.md', 'docs/y.md', 'README.md', 'locales/en/common.json'],
        policy,
      ),
    ).toEqual(['a.ts', 'README.md', 'locales/en/common.json']);
  });

  it('credentialAllowlist exempts a file or a directory', () => {
    const withAllow = bareRealPolicy({
      credentialAllowlist: [
        { path: 'src/allowed.ts', ...DECISION },
        { path: 'fixtures/', ...DECISION },
      ],
    });
    const content = `x = '${FORBIDDEN_PATTERNS[1] ?? ''}'`;
    const result = scan(
      { 'src/allowed.ts': content, 'fixtures/deep/a.txt': content, 'src/other.ts': content },
      withAllow,
    );
    expect(result.findings.map((f) => f.subject)).toEqual(['src/other.ts:1']);
  });
});
