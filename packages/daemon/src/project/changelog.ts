// SPDX-License-Identifier: MPL-2.0
import type { ChangelogFormat, CommitType } from '@otheater/core';

/** The changelog is a delivery artifact built from the store, never from what a model wrote. */
export interface ChangelogEntry {
  /** One line: what the delivery did. */
  readonly summary: string;
  /** Lines under it (the titles of the demands), when there are more than one demand. */
  readonly details: readonly string[];
  readonly type: CommitType;
}

/** The file a new project or a repository without a changelog gets. */
export const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';

const KEEP_SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;
const CONVENTIONAL_SECTIONS = [
  'Features',
  'Bug Fixes',
  'Performance Improvements',
  'Miscellaneous Chores',
] as const;

/** Section of Keep a Changelog for the type of the change. */
export function keepSectionOf(type: CommitType): string {
  if (type === 'feat') return 'Added';
  if (type === 'fix') return 'Fixed';
  return 'Changed';
}

/** Section of conventional-changelog for the type of the change. */
export function conventionalSectionOf(type: CommitType): string {
  if (type === 'feat') return 'Features';
  if (type === 'fix') return 'Bug Fixes';
  if (type === 'perf') return 'Performance Improvements';
  return 'Miscellaneous Chores';
}

/** The text of a new changelog (Keep a Changelog 1.1.0) with the entry under `[Unreleased]`. */
export function newChangelog(entry: ChangelogEntry): string {
  return [
    '# Changelog',
    '',
    'All notable changes to this project will be documented in this file.',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
    '',
    '## [Unreleased]',
    '',
    `### ${keepSectionOf(entry.type)}`,
    '',
    ...bulletLines(entry, '-'),
    '',
  ].join('\n');
}

function bulletLines(entry: ChangelogEntry, marker: string): string[] {
  return [`${marker} ${entry.summary}`, ...entry.details.map((detail) => `  ${marker} ${detail}`)];
}

interface Layout {
  readonly eol: string;
  /** The lines, without the empty one a trailing newline leaves. */
  readonly lines: string[];
  trailingNewline: boolean;
}

function layoutOf(text: string): Layout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 1 && lines.at(-1) === '';
  if (trailingNewline) lines.pop();
  return { eol, lines, trailingNewline };
}

function render(layout: Layout): string {
  return layout.lines.join(layout.eol) + (layout.trailingNewline ? layout.eol : '');
}

/** Bullet marker (`-`, `*`, `+`) of the first top-level bullet in `lines`, else `fallback`. */
function markerOf(lines: readonly string[], fallback: string): string {
  for (const line of lines) {
    const match = /^([-*+]) \S/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return fallback;
}

function isHeading(line: string, level: number): boolean {
  return new RegExp(`^#{${String(level)}}(?!#)\\s`).test(line);
}

/** End (exclusive) of the block that starts at `from`: the next heading of `level` or above. */
function blockEnd(lines: readonly string[], from: number, level: number): number {
  for (let index = from + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (let up = 1; up <= level; up += 1) if (isHeading(line, up)) return index;
  }
  return lines.length;
}

/** Index after the last non-blank line in `[from, to)`; `from` when all are blank. */
function afterContent(lines: readonly string[], from: number, to: number): number {
  let end = to;
  while (end > from && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return end;
}

interface UnreleasedStyle {
  /** Matches the heading of the section of the work not released yet. */
  readonly heading: RegExp;
  /** Heading to write when the file has no such section. */
  readonly newHeading: string;
  readonly sections: readonly string[];
  readonly section: string;
  readonly marker: string;
}

/**
 * Puts the entry in the section of the unreleased work, in the subsection of its type, creating
 * what is missing in the order of the format. The first `##` heading that is not the unreleased
 * one is where a new section goes (above the releases); a file with no `##` gets it at the end.
 */
function insertUnreleased(text: string, entry: ChangelogEntry, style: UnreleasedStyle): string {
  const layout = layoutOf(text);
  const { lines } = layout;
  const unreleased = lines.findIndex((line) => isHeading(line, 2) && style.heading.test(line));
  const heading = `### ${style.section}`;
  if (unreleased < 0) {
    const marker = markerOf(lines, style.marker);
    const section = [style.newHeading, '', heading, '', ...bulletLines(entry, marker)];
    const firstRelease = lines.findIndex((line) => isHeading(line, 2));
    if (firstRelease >= 0) {
      lines.splice(firstRelease, 0, ...section, '');
    } else {
      lines.splice(afterContent(lines, 0, lines.length));
      lines.push(...(lines.length > 0 ? [''] : []), ...section);
      layout.trailingNewline = true;
    }
    return render(layout);
  }
  const end = blockEnd(lines, unreleased, 2);
  const existing = lines
    .slice(unreleased + 1, end)
    .findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (existing >= 0) {
    const start = unreleased + 1 + existing;
    const subEnd = blockEnd(lines, start, 3);
    const marker = markerOf(lines.slice(start + 1, subEnd), style.marker);
    const at = afterContent(lines, start + 1, subEnd);
    lines.splice(at, 0, ...(at === start + 1 ? [''] : []), ...bulletLines(entry, marker));
    return render(layout);
  }
  // A new subsection goes before the first existing one that comes later in the order of the
  // format, else after the last content of the unreleased block.
  const rank = style.sections.indexOf(style.section);
  const marker = markerOf(lines.slice(unreleased + 1, end), style.marker);
  const later = lines.findIndex((line, index) => {
    if (index <= unreleased || index >= end) return false;
    const name = /^###\s+(.+?)\s*$/.exec(line)?.[1];
    return name !== undefined && style.sections.indexOf(name) > rank;
  });
  if (later >= 0) {
    lines.splice(later, 0, heading, '', ...bulletLines(entry, marker), '');
  } else {
    const at = afterContent(lines, unreleased + 1, end);
    lines.splice(at, 0, '', heading, '', ...bulletLines(entry, marker));
  }
  return render(layout);
}

/**
 * Any other format: one bullet above the first bullet of the file, in its marker; else under the
 * title. It does not impose a structure the file does not have.
 */
function insertPlain(text: string, entry: ChangelogEntry): string {
  const layout = layoutOf(text);
  const { lines } = layout;
  const title = lines.findIndex((line) => line.trim() !== '');
  const underlined = title >= 0 && /^(={3,}|-{3,})\s*$/.test(lines[title + 1] ?? '');
  const titleEnd = title < 0 ? -1 : title + (underlined ? 1 : 0);
  // Sections after the title (releases, say): a bullet in one of them is not the place for work
  // that is not released, so the entry goes under the title instead.
  const sectioned = lines.some(
    (line, index) =>
      index > titleEnd && (/^#{1,6}\s/.test(line) || /^(={3,}|-{3,})\s*$/.test(line)),
  );
  const first = lines.findIndex((line, index) => index > titleEnd && /^[-*+] \S/.test(line));
  if (first >= 0 && !sectioned) {
    const marker = /^([-*+])/.exec(lines[first] ?? '')?.[1] ?? '-';
    lines.splice(first, 0, ...bulletLines(entry, marker));
    return render(layout);
  }
  const bullets = bulletLines(entry, '-');
  if (title < 0) {
    // A blank file: the entry is all of it.
    lines.splice(0, lines.length, ...bullets);
    layout.trailingNewline = true;
    return render(layout);
  }
  const at = titleEnd + 1;
  lines.splice(at, 0, '', ...bullets);
  const after = at + 1 + bullets.length;
  if (after < lines.length && (lines[after] ?? '') !== '') lines.splice(after, 0, '');
  layout.trailingNewline = true;
  return render(layout);
}

/** True when the entry is already in the file, so repeating the delivery adds nothing. */
export function hasEntry(text: string, entry: ChangelogEntry): boolean {
  return text.split(/\r?\n/).some((line) => line.replace(/^\s*[-*+]\s+/, '') === entry.summary);
}

/**
 * The text of the changelog with the entry, in the format the file already has. The text comes
 * back unchanged when the entry is already there.
 */
export function insertEntry(
  format: Exclude<ChangelogFormat, 'none'>,
  text: string,
  entry: ChangelogEntry,
): string {
  if (hasEntry(text, entry)) return text;
  if (format === 'keep-a-changelog') {
    return insertUnreleased(text, entry, {
      heading: /^##\s*\[?unreleased\]?/i,
      newHeading: '## [Unreleased]',
      sections: KEEP_SECTIONS,
      section: keepSectionOf(entry.type),
      marker: '-',
    });
  }
  if (format === 'conventional-changelog') {
    return insertUnreleased(text, entry, {
      heading: /^##\s*\[?unreleased\]?/i,
      newHeading: '## Unreleased',
      sections: CONVENTIONAL_SECTIONS,
      section: conventionalSectionOf(entry.type),
      marker: '*',
    });
  }
  return insertPlain(text, entry);
}
