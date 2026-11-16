// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import type { CheckResult, Finding } from './common.js';
import type { CopiedEntry } from './copied-code.js';
import { isInside, type SourceFile } from './files.js';
import type { Policy } from './policy.js';

export function selectHeaderFiles(paths: readonly string[], policy: Policy): string[] {
  const { extensions, excludedPrefixes, excludedDirectories } = policy.headers;
  return paths.filter(
    (p) =>
      extensions.includes(path.posix.extname(p)) &&
      !excludedPrefixes.some((prefix) => p.startsWith(prefix)) &&
      !excludedDirectories.some((dir) => isInside(p, dir)),
  );
}

const SPDX_LINE = /^\s*(?:\/\/+|\/\*+|\*|#)\s*SPDX-License-Identifier:\s*(.*?)\s*(?:\*\/)?\s*$/;
const COPIED_FROM =
  /^\s*(?:\/\/+|\/\*+|\*)?\s*Copied-From:\s*(\S+)\s+(\S+)\s+(\S+)\s*(?:\*\/)?\s*$/;
const MODIFIED = /^\s*(?:\/\/+|\/\*+|\*)?\s*Modified:\s*\S/;

/** The leading comment block (after an optional shebang): consecutive `//` lines or a `/* ... *\/` block. */
function leadingComment(lines: readonly string[]): string[] {
  const block: string[] = [];
  let start = 0;
  if (lines[0]?.startsWith('#!') === true) start = 1;
  let inBlock = false;
  for (const line of lines.slice(start)) {
    const trimmed = line.trim();
    if (inBlock) {
      block.push(line);
      if (trimmed.includes('*/')) inBlock = false;
    } else if (trimmed.startsWith('//')) {
      block.push(line);
    } else if (trimmed.startsWith('/*')) {
      block.push(line);
      if (!trimmed.includes('*/')) inBlock = true;
    } else {
      break;
    }
  }
  return block;
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

export function checkHeaders(
  files: readonly SourceFile[],
  policy: Policy,
  copied: readonly CopiedEntry[],
): CheckResult {
  const findings: Finding[] = [];
  const allowed = new Set(policy.allowed.map(normalizeId));
  const own = normalizeId(policy.headers.ownLicense);
  const copiedByFile = new Map<string, CopiedEntry>();
  for (const entry of copied) for (const file of entry.localFiles) copiedByFile.set(file, entry);
  let ownCount = 0;
  let copiedCount = 0;
  const error = (subject: string, message: string): void => {
    findings.push({ severity: 'error', subject, message });
  };

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    const head = lines.slice(0, policy.headers.headerLines);
    let id: string | undefined;
    for (const line of head) {
      const match = SPDX_LINE.exec(line);
      if (match?.[1] !== undefined && match[1] !== '') {
        id = match[1];
        break;
      }
    }
    if (id === undefined) {
      error(
        file.path,
        `missing "SPDX-License-Identifier: ${policy.headers.ownLicense}" comment in the first ${String(policy.headers.headerLines)} lines`,
      );
      continue;
    }
    if (normalizeId(id) === own) {
      ownCount++;
      continue;
    }

    // Any other identifier: a file copied from a third party.
    copiedCount++;
    if (!allowed.has(normalizeId(id))) {
      error(file.path, `license "${id}" is not on the allowed list`);
      continue;
    }
    const header = leadingComment(lines);
    if (!header.some((line) => COPIED_FROM.test(line))) {
      error(
        file.path,
        'copied file (license other than the project\'s) needs a "Copied-From: <project> <path> <commit>" line in its header',
      );
    }
    const entry = copiedByFile.get(file.path);
    if (entry === undefined) {
      error(file.path, 'copied file is not listed in copied-code.json (localFiles)');
    } else {
      if (normalizeId(entry.license) !== normalizeId(id)) {
        error(
          file.path,
          `header license "${id}" differs from copied-code.json ("${entry.license}")`,
        );
      }
    }
    if (normalizeId(id) === 'apache-2.0' && !header.some((line) => MODIFIED.test(line))) {
      findings.push({
        severity: 'warning',
        subject: file.path,
        message:
          'Apache-2.0 file without "Modified:" in the header; if you changed it, it needs one (an alteration cannot be detected automatically)',
      });
    }
  }
  return {
    summary: [
      `files checked: ${String(files.length)} (own ${policy.headers.ownLicense}: ${String(ownCount)}; copied from third parties: ${String(copiedCount)})`,
    ],
    findings,
  };
}
