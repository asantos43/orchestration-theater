// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import {
  compareStrings,
  fail,
  requireArray,
  requireRecord,
  requireString,
  requireStringArray,
  UsageError,
} from './common.js';

/** Level A (copied code or fork): one entry per upstream project and commit. */
export interface CopiedEntry {
  project: string;
  license: string;
  sourcePath: string;
  commit: string;
  /** Repository-relative paths of the files copied from the project. */
  localFiles: string[];
  copyrightNotice: string;
}

export function parseCopiedCode(raw: unknown, where = 'copied-code.json'): CopiedEntry[] {
  const root = requireRecord(raw, where);
  const entries = requireArray(root.entries, `${where}.entries`);
  return entries.map((item, i) => {
    const at = `${where}.entries[${String(i)}]`;
    const rec = requireRecord(item, at);
    const localFiles = requireStringArray(rec.localFiles, `${at}.localFiles`);
    if (localFiles.length === 0) fail(at, '"localFiles" must not be empty');
    return {
      project: requireString(rec, 'project', at),
      license: requireString(rec, 'license', at),
      sourcePath: requireString(rec, 'sourcePath', at),
      commit: requireString(rec, 'commit', at),
      localFiles,
      copyrightNotice: requireString(rec, 'copyrightNotice', at),
    };
  });
}

export function loadCopiedCode(file: string): CopiedEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseCopiedCode(json, 'copied-code.json');
}

export function sortCopied(entries: readonly CopiedEntry[]): CopiedEntry[] {
  return [...entries].sort(
    (a, b) => compareStrings(a.project, b.project) || compareStrings(a.commit, b.commit),
  );
}
