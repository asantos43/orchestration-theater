// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  conventionalSectionOf,
  insertEntry,
  keepSectionOf,
  newChangelog,
  type ChangelogEntry,
} from './changelog.js';
import { detectChangelogFormat } from './detect.js';

const entry: ChangelogEntry = { summary: 'Add the export command', details: [], type: 'feat' };

describe('sections of the types', () => {
  it('maps the types to the sections of each format', () => {
    expect(keepSectionOf('feat')).toBe('Added');
    expect(keepSectionOf('fix')).toBe('Fixed');
    expect(keepSectionOf('docs')).toBe('Changed');
    expect(conventionalSectionOf('feat')).toBe('Features');
    expect(conventionalSectionOf('fix')).toBe('Bug Fixes');
    expect(conventionalSectionOf('perf')).toBe('Performance Improvements');
    expect(conventionalSectionOf('chore')).toBe('Miscellaneous Chores');
  });
});

describe('newChangelog', () => {
  it('is a Keep a Changelog file with the entry under Unreleased', () => {
    const text = newChangelog(entry);
    expect(text).toBe(
      [
        '# Changelog',
        '',
        'All notable changes to this project will be documented in this file.',
        '',
        'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '',
        '- Add the export command',
        '',
      ].join('\n'),
    );
    expect(detectChangelogFormat(text)).toBe('keep-a-changelog');
  });

  it('lists the details under the summary', () => {
    const text = newChangelog({ ...entry, details: ['Parse the flags', 'Write the file'] });
    expect(text).toContain('- Add the export command\n  - Parse the flags\n  - Write the file\n');
  });
});

describe('insertEntry in Keep a Changelog', () => {
  const file = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Fixed',
    '',
    '- a fix',
    '',
    '## [1.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    '- the first thing',
    '',
  ].join('\n');

  it('creates the subsection of the type in the order of the format', () => {
    const text = insertEntry('keep-a-changelog', file, entry);
    expect(text).toBe(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '',
        '- Add the export command',
        '',
        '### Fixed',
        '',
        '- a fix',
        '',
        '## [1.0.0] - 2026-01-01',
        '',
        '### Added',
        '',
        '- the first thing',
        '',
      ].join('\n'),
    );
  });

  it('adds to a subsection that exists, after its last bullet and in its marker', () => {
    const starred = file.replace('- a fix', '* a fix');
    const text = insertEntry('keep-a-changelog', starred, {
      ...entry,
      summary: 'Fix the export',
      type: 'fix',
    });
    expect(text).toContain('### Fixed\n\n* a fix\n* Fix the export\n\n## [1.0.0]');
  });

  it('creates the Unreleased section above the releases when the file has none', () => {
    const released = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-01-01',
      '',
      '### Added',
      '',
      '- x',
      '',
    ].join('\n');
    const text = insertEntry('keep-a-changelog', released, entry);
    expect(text).toBe(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '',
        '- Add the export command',
        '',
        '## [1.0.0] - 2026-01-01',
        '',
        '### Added',
        '',
        '- x',
        '',
      ].join('\n'),
    );
  });

  it('puts a new subsection after an empty Unreleased section', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n';
    const text = insertEntry('keep-a-changelog', empty, entry);
    expect(text).toBe(
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Add the export command\n\n## [1.0.0] - 2026-01-01\n',
    );
  });

  it('keeps CRLF line endings', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const text = insertEntry('keep-a-changelog', crlf, entry);
    expect(text).toContain('### Added\r\n\r\n- Add the export command\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('does not add an entry that is already in the file', () => {
    const once = insertEntry('keep-a-changelog', file, entry);
    expect(insertEntry('keep-a-changelog', once, entry)).toBe(once);
  });
});

describe('insertEntry in conventional-changelog', () => {
  const file = [
    '# Changelog',
    '',
    '## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-02-01)',
    '',
    '### Features',
    '',
    '* a feature',
    '',
  ].join('\n');

  it('adds an Unreleased section with the section and the marker of the format', () => {
    const text = insertEntry('conventional-changelog', file, entry);
    expect(text).toBe(
      [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '### Features',
        '',
        '* Add the export command',
        '',
        '## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-02-01)',
        '',
        '### Features',
        '',
        '* a feature',
        '',
      ].join('\n'),
    );
  });

  it('uses the Bug Fixes section for a fix', () => {
    const text = insertEntry('conventional-changelog', file, { ...entry, type: 'fix' });
    expect(text).toContain('## Unreleased\n\n### Bug Fixes\n\n* Add the export command\n');
  });
});

describe('insertEntry in another format', () => {
  it('puts a bullet above the first one, in its marker', () => {
    const text = insertEntry('other', '# History\n\n* second\n* first\n', entry);
    expect(text).toBe('# History\n\n* Add the export command\n* second\n* first\n');
  });

  it('puts the entry under the title when the file has sections', () => {
    const text = insertEntry('other', '# History\n\n## v1\n\n- one\n', entry);
    expect(text).toBe('# History\n\n- Add the export command\n\n## v1\n\n- one\n');
  });

  it('puts the entry under an underlined title', () => {
    const text = insertEntry('other', 'History\n=======\n\nv1: first\n', entry);
    expect(text).toBe('History\n=======\n\n- Add the export command\n\nv1: first\n');
  });

  it('works on an empty file', () => {
    expect(insertEntry('other', '', entry)).toBe('- Add the export command\n');
  });
});
