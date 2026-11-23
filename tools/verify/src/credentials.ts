// SPDX-License-Identifier: MPL-2.0
import type { CheckResult, Finding } from './common.js';
import type { SourceFile } from './files.js';
import type { Policy } from './policy.js';

// The forbidden strings are built from pieces on purpose: this source must not contain them literally, so the lock
// needs no exception for its own files (and a plain search for them finds only real uses).
export const FORBIDDEN_PATTERNS: readonly string[] = [
  ['.credentials', '.json'].join(''),
  ['auth', '.json'].join(''),
  ['/api/', 'oauth/'].join(''),
  ['backend-api/', 'codex'].join(''),
];

export function selectCredentialFiles(paths: readonly string[], policy: Policy): string[] {
  return paths.filter(
    (p) => !policy.credentials.excludedPrefixes.some((prefix) => p.startsWith(prefix)),
  );
}

function isAllowlisted(file: string, policy: Policy): boolean {
  return policy.credentialAllowlist.some((entry) =>
    entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path,
  );
}

/**
 * A lint, not a guarantee. It is a case-insensitive literal search for the file names and endpoints
 * in {@link FORBIDDEN_PATTERNS}, in the files the policy selects: it catches a careless mention, but
 * not a path built from pieces, read from the environment or decoded at run time, and not a
 * credential that is not one of the listed names. That OTheater never reads or copies a client's
 * credentials is held by the code and its review (architecture 6.3), not by this check.
 * Never prints the matching line: only file, line number and which pattern.
 */
export function checkCredentials(files: readonly SourceFile[], policy: Policy): CheckResult {
  const findings: Finding[] = [];
  const patterns = FORBIDDEN_PATTERNS.map((p) => p.toLowerCase());
  let allowlisted = 0;
  for (const file of files) {
    if (isAllowlisted(file.path, policy)) {
      allowlisted++;
      continue;
    }
    const lines = file.content.toLowerCase().split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const [k, pattern] of patterns.entries()) {
        if (line.includes(pattern)) {
          findings.push({
            severity: 'error',
            subject: `${file.path}:${String(index + 1)}`,
            message: `forbidden credential file name or endpoint "${FORBIDDEN_PATTERNS[k] ?? pattern}" (architecture 6.3); if it is legitimate, add the file to credentialAllowlist in policy.json with a reason`,
          });
        }
      }
    }
  }
  return {
    summary: [
      `files scanned: ${String(files.length)} (allowlisted: ${String(allowlisted)}); patterns: ${String(patterns.length)}`,
    ],
    findings,
  };
}
