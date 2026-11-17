// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_IDS,
  loadConfig,
  parseConfig,
  parseDuration,
  parseTimeOfDay,
  sessionsPerProcessOf,
} from './config.js';
import { executionSettingsOf, sessionsPerProcessFor } from './execution/settings.js';
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
      pages_per_step: 'all',
    });
    expect(config.ui.locale).toBe('auto');
    expect(config.log).toEqual({ level: 'info', destination: 'file' });
  });

  it('takes backup.pages_per_step as "all" or an integer >= 1', () => {
    expect(parseConfig('backup:\n  pages_per_step: all\n').backup.pages_per_step).toBe('all');
    expect(parseConfig('backup:\n  pages_per_step: 500\n').backup.pages_per_step).toBe(500);
    expect(parseConfig('backup:\n  pages_per_step: 1\n').backup.pages_per_step).toBe(1);
    for (const bad of ['0', '-5', '1.5', 'few', '"500"', 'null']) {
      expect(() => parseConfig(`backup:\n  pages_per_step: ${bad}\n`), bad).toThrow(
        /backup\.pages_per_step/,
      );
    }
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

describe('parseConfig, execution keys', () => {
  it('has the pool, limits and resume defaults of the architecture (5.2, 5.4, 5.16)', () => {
    const config = parseConfig('');
    expect(config.pool).toEqual({
      sessions_per_process: 4,
      max_sessions: 4,
      idle: 120_000,
      shared_cancel: 'escalate',
      'claude-code': {},
      codex: {},
      opencode: { process_model: 'per_profile' },
    });
    expect(config.limits).toEqual({ demand_timeout: 1_800_000, demand_timeout_max: 7_200_000 });
    expect(config.resume).toMatchObject({
      preset: 'balanced',
      max_resumes: 5,
      max_free_resumes: 3,
      quota_wait_max: 1_800_000,
      checkpoint_every: 600_000,
      stuck: { no_event_for: 600_000, same_error_times: 3 },
      transient_backoff: [30_000, 120_000, 600_000],
    });
  });

  it('fills the resume values from the preset, and an individual key overrides only itself', () => {
    expect(parseConfig('resume:\n  preset: agile\n').resume).toMatchObject({
      max_resumes: 3,
      checkpoint_every: 300_000,
      stuck: { no_event_for: 300_000, same_error_times: 2 },
      transient_backoff: [30_000, 120_000, 600_000],
    });
    const patient = parseConfig(
      'resume:\n  preset: patient\n  max_resumes: 1\n  stuck:\n    same_error_times: 2\n  transient_backoff: [1s, 2s]\n',
    ).resume;
    expect(patient).toMatchObject({
      max_resumes: 1,
      quota_wait_max: 7_200_000,
      checkpoint_every: 900_000,
      stuck: { no_event_for: 1_200_000, same_error_times: 2 },
      transient_backoff: [1000, 2000],
    });
  });

  it('takes resume.max_free_resumes as 3 in every preset, and zero turns the free resumes off', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      expect(parseConfig(`resume:\n  preset: ${preset}\n`).resume.max_free_resumes).toBe(3);
    }
    expect(parseConfig('resume:\n  max_free_resumes: 0\n').resume.max_free_resumes).toBe(0);
    expect(() => parseConfig('resume:\n  max_free_resumes: -1\n')).toThrow(/max_free_resumes/);
  });

  it('defaults security.catalog_probe to allow and takes refuse', () => {
    expect(parseConfig('').security.catalog_probe).toBe('allow');
    expect(parseConfig('security:\n  catalog_probe: refuse\n').security.catalog_probe).toBe(
      'refuse',
    );
    expect(() => parseConfig('security:\n  catalog_probe: maybe\n')).toThrow(/catalog_probe/);
  });

  it('defaults security.catalog_probe_log to once and takes every and off', () => {
    expect(parseConfig('').security.catalog_probe_log).toBe('once');
    for (const mode of ['once', 'every', 'off']) {
      expect(
        parseConfig(`security:\n  catalog_probe_log: ${mode}\n`).security.catalog_probe_log,
      ).toBe(mode);
    }
    expect(() => parseConfig('security:\n  catalog_probe_log: sometimes\n')).toThrow(
      /catalog_probe_log/,
    );
  });

  it('rejects a timeout above the ceiling, a bad preset and a bad process model', () => {
    expect(() => parseConfig('limits:\n  demand_timeout: 3h\n')).toThrow(/demand_timeout/);
    expect(() => parseConfig('resume:\n  preset: lazy\n')).toThrow(/resume\.preset/);
    expect(() => parseConfig('pool:\n  opencode:\n    process_model: shared\n')).toThrow(
      /process_model/,
    );
    expect(() => parseConfig('pool:\n  sessions_per_process: 0\n')).toThrow(/sessions_per_process/);
  });

  describe('pool.<client>.sessions_per_process', () => {
    it('inherits the global key when the client sets none', () => {
      const pool = parseConfig('').pool;
      for (const client of CLIENT_IDS) expect(sessionsPerProcessOf(pool, client)).toBe(4);
    });

    it('follows the global key for the clients without one, and wins where present', () => {
      const pool = parseConfig(
        'pool:\n  sessions_per_process: 6\n  codex:\n    sessions_per_process: 2\n  opencode:\n    sessions_per_process: 9\n',
      ).pool;
      expect(sessionsPerProcessOf(pool, 'claude-code')).toBe(6);
      expect(sessionsPerProcessOf(pool, 'codex')).toBe(2);
      expect(sessionsPerProcessOf(pool, 'opencode')).toBe(9);
      expect(pool.codex.sessions_per_process).toBe(2);
      expect(pool['claude-code'].sessions_per_process).toBeUndefined();
    });

    it('reaches the pool settings as the effective K of each client', () => {
      const { pool } = executionSettingsOf(
        parseConfig('pool:\n  sessions_per_process: 6\n  codex:\n    sessions_per_process: 2\n'),
      );
      expect(sessionsPerProcessFor(pool, 'codex')).toBe(2);
      expect(sessionsPerProcessFor(pool, 'claude-code')).toBe(6);
      expect(sessionsPerProcessFor(pool, 'opencode')).toBe(6);
      // A client the settings do not name uses the global value.
      expect(sessionsPerProcessFor(pool, 'fake')).toBe(6);
    });

    it('rejects a value below 1, a non-integer and an unknown client', () => {
      for (const client of CLIENT_IDS) {
        expect(() => parseConfig(`pool:\n  ${client}:\n    sessions_per_process: 0\n`)).toThrow(
          /sessions_per_process/,
        );
        expect(() => parseConfig(`pool:\n  ${client}:\n    sessions_per_process: 1.5\n`)).toThrow(
          /sessions_per_process/,
        );
      }
      expect(() => parseConfig('pool:\n  gemini:\n    sessions_per_process: 2\n')).toThrow(
        /gemini/,
      );
      expect(() => parseConfig('pool:\n  codex:\n    nope: 2\n')).toThrow(/nope/);
    });
  });

  it('takes the three modes of pool.shared_cancel and rejects any other', () => {
    for (const mode of ['escalate', 'always_kill', 'release']) {
      expect(parseConfig(`pool:\n  shared_cancel: ${mode}\n`).pool.shared_cancel).toBe(mode);
    }
    expect(() => parseConfig('pool:\n  shared_cancel: kill\n')).toThrow(/shared_cancel/);
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
