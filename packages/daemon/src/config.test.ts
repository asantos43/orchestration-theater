// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig, parseDuration, parseTimeOfDay } from './config.js';
import { makeTempDataDir } from './test-helpers.js';

describe('parseDuration / parseTimeOfDay', () => {
  it('reads units and rejects the rest', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('500ms')).toBe(500);
    for (const bad of ['', '30', 'm', '1.5h', '-5m', '5 min', 'abc']) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });

  it('reads HH:MM in 24 hours', () => {
    expect(parseTimeOfDay('03:00')).toEqual({ hour: 3, minute: 0 });
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const bad of ['24:00', '3:00', '03:60', '03', '']) {
      expect(parseTimeOfDay(bad)).toBeUndefined();
    }
  });
});

describe('parseConfig', () => {
  it('gives every default for an empty file or only comments', () => {
    const config = parseConfig('# nothing here\n');
    expect(config).toEqual(parseConfig(''));
    expect(config.adapters).toEqual({ store: 'sqlite', vault: 'keyring', clock: 'system' });
    expect(config.backup).toEqual({
      when: 'daily_after',
      after: '03:00',
      idle: 1_800_000,
      dir: 'backups',
      retention: 'days',
      keep_days: 2,
      copies: 7,
      content: 'without_runs',
      method: 'online_api',
    });
    expect(config.ui.locale).toBe('auto');
    expect(config.log).toEqual({ level: 'info', destination: 'file' });
  });

  it('keeps "03:00" a string (YAML 1.2) and converts durations to milliseconds', () => {
    const config = parseConfig(
      'backup:\n  after: "03:00"\n  idle: 2h\n  retention: copies\n  copies: 3\n',
    );
    expect(config.backup.after).toBe('03:00');
    expect(config.backup.idle).toBe(7_200_000);
    expect(config.backup.copies).toBe(3);
    // Unquoted too: this must not turn into the sexagesimal number 180.
    expect(parseConfig('backup:\n  after: 03:00\n').backup.after).toBe('03:00');
  });

  it('names the key path of a bad value', () => {
    expect(() => parseConfig('backup:\n  keep_days: 0\n')).toThrow(/backup\.keep_days/);
    expect(() => parseConfig('backup:\n  idle: soon\n')).toThrow(/backup\.idle/);
    expect(() => parseConfig('backup:\n  after: "25:00"\n')).toThrow(/backup\.after/);
    expect(() => parseConfig('ui:\n  locale: fr\n')).toThrow(/ui\.locale/);
  });

  it('rejects an unknown key at every level, naming it', () => {
    expect(() => parseConfig('backups: {}\n')).toThrow(/backups/);
    expect(() => parseConfig('backup:\n  retenton: days\n')).toThrow(/retenton/);
    expect(() => parseConfig('log:\n  lvl: info\n')).toThrow(/lvl/);
  });

  it('rejects text that is not YAML, with the file name', () => {
    const run = (): unknown => parseConfig('backup: [unclosed\n', 'my.yaml');
    expect(run).toThrow(InvalidInput);
    expect(run).toThrow(/my\.yaml: not valid YAML/);
  });

  it('rejects a top-level value that is not a mapping', () => {
    expect(() => parseConfig('- a\n- b\n')).toThrow(InvalidInput);
  });
});

describe('loadConfig', () => {
  it('treats a missing file as the defaults and reads an existing one', async () => {
    const tmp = await makeTempDataDir();
    try {
      const file = join(tmp.dir, 'config.yaml');
      expect((await loadConfig(file)).ui.locale).toBe('auto');
      await writeFile(file, 'ui:\n  locale: pt-BR\n');
      expect((await loadConfig(file)).ui.locale).toBe('pt-BR');
    } finally {
      await tmp.dispose();
    }
  });
});
