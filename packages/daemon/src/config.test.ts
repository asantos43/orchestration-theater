// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, PROMPT_ORDER_MODES } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_IDS,
  LIMIT_PRESETS,
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
    expect(config.adapters).toEqual({
      store: 'sqlite',
      vault: 'keyring',
      clock: 'system',
      prompts: 'files',
    });
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

describe('parseConfig, limits (architecture 5.4)', () => {
  // The table of 5.4, written out so a change of a preset shows up here.
  const TABLE = {
    moderate: [2, 2, 3, 3, 2, 2, 1, 2, 30, 120],
    economical: [1, 1, 2, 2, 1, 1, 0, 1, 20, 60],
    persistent: [3, 3, 4, 4, 3, 3, 2, 3, 45, 180],
  } as const;

  it.each(Object.entries(TABLE))('the %s preset fills every key', (name, row) => {
    const limits = parseConfig(`limits:\n  preset: ${name}\n`).limits;
    expect(limits).toEqual({
      preset: name,
      plan_reviews: row[0],
      critic_rejections: row[1],
      attempts_per_demand: row[2],
      script_validations: row[3],
      script_vetoes: row[4],
      script_returns: row[5],
      structural_restarts: row[6],
      submit_retries: row[7],
      demand_timeout: row[8] * 60_000,
      demand_timeout_max: row[9] * 60_000,
    });
  });

  it('defaults to the moderate preset', () => {
    expect(parseConfig('').limits.preset).toBe('moderate');
  });

  it('lets one key override only its own value, on top of any preset', () => {
    const limits = parseConfig(
      'limits:\n  preset: economical\n  plan_reviews: 5\n  submit_retries: 0\n  demand_timeout: 10m\n',
    ).limits;
    expect(limits).toEqual({
      ...LIMIT_PRESETS.economical,
      preset: 'economical',
      plan_reviews: 5,
      submit_retries: 0,
      demand_timeout: 600_000,
    });
  });

  it('keeps submit_retries at 2 by default (N79) and checks the timeout against the ceiling', () => {
    expect(parseConfig('').limits.submit_retries).toBe(2);
    expect(() => parseConfig('limits:\n  preset: economical\n  demand_timeout: 90m\n')).toThrow(
      /demand_timeout must not exceed/,
    );
    expect(
      parseConfig('limits:\n  preset: economical\n  demand_timeout_max: 4h\n').limits
        .demand_timeout_max,
    ).toBe(14_400_000);
  });

  it('rejects an unknown preset, an unknown key, a negative count and zero attempts', () => {
    expect(() => parseConfig('limits:\n  preset: lazy\n')).toThrow(/limits\.preset/);
    expect(() => parseConfig('limits:\n  retries: 3\n')).toThrow(InvalidInput);
    expect(() => parseConfig('limits:\n  plan_reviews: -1\n')).toThrow(/plan_reviews/);
    expect(() => parseConfig('limits:\n  attempts_per_demand: 0\n')).toThrow(/attempts_per_demand/);
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
      codex: { sessions_per_process: 6 },
      opencode: { sessions_per_process: 4, process_model: 'per_profile' },
    });
    expect(config.limits).toEqual({
      preset: 'moderate',
      ...LIMIT_PRESETS.moderate,
      demand_timeout: 1_800_000,
      demand_timeout_max: 7_200_000,
    });
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

  it('defaults delivery to a PR without direct merge (N5) and takes the three modes', () => {
    expect(parseConfig('').delivery).toEqual({ mode: 'pr', allow_direct_merge: false });
    for (const mode of ['pr', 'direct_merge', 'ask']) {
      expect(parseConfig(`delivery:\n  mode: ${mode}\n`).delivery.mode).toBe(mode);
    }
    expect(parseConfig('delivery:\n  allow_direct_merge: true\n').delivery).toEqual({
      mode: 'pr',
      allow_direct_merge: true,
    });
    expect(() => parseConfig('delivery:\n  mode: merge\n')).toThrow(/mode/);
    expect(() => parseConfig('delivery:\n  allow_direct_merge: yes please\n')).toThrow(
      /allow_direct_merge/,
    );
    expect(() => parseConfig('delivery:\n  extra: 1\n')).toThrow(/extra/);
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
    it('has the per-client defaults of N74 without any config', () => {
      const pool = parseConfig('').pool;
      expect(sessionsPerProcessOf(pool, 'claude-code')).toBe(4);
      expect(sessionsPerProcessOf(pool, 'codex')).toBe(6);
      expect(sessionsPerProcessOf(pool, 'opencode')).toBe(4);
      expect(pool['claude-code'].sessions_per_process).toBeUndefined();
      expect(pool.codex.sessions_per_process).toBe(6);
      expect(pool.opencode.sessions_per_process).toBe(4);
    });

    it('changes only Claude Code when the global key changes', () => {
      const pool = parseConfig('pool:\n  sessions_per_process: 7\n').pool;
      expect(sessionsPerProcessOf(pool, 'claude-code')).toBe(7);
      expect(sessionsPerProcessOf(pool, 'codex')).toBe(6);
      expect(sessionsPerProcessOf(pool, 'opencode')).toBe(4);
    });

    it('lets each client override its own value, and Claude Code override the global', () => {
      const pool = parseConfig(
        'pool:\n  sessions_per_process: 6\n  codex:\n    sessions_per_process: 2\n  opencode:\n    sessions_per_process: 9\n  claude-code:\n    sessions_per_process: 3\n',
      ).pool;
      expect(sessionsPerProcessOf(pool, 'claude-code')).toBe(3);
      expect(sessionsPerProcessOf(pool, 'codex')).toBe(2);
      expect(sessionsPerProcessOf(pool, 'opencode')).toBe(9);
      // Overriding one client leaves the others on their defaults.
      const only = parseConfig('pool:\n  codex:\n    sessions_per_process: 1\n').pool;
      expect(sessionsPerProcessOf(only, 'codex')).toBe(1);
      expect(sessionsPerProcessOf(only, 'opencode')).toBe(4);
      expect(sessionsPerProcessOf(only, 'claude-code')).toBe(4);
    });

    it('reaches the pool settings as the effective K of each client', () => {
      const defaults = executionSettingsOf(parseConfig('')).pool;
      expect(sessionsPerProcessFor(defaults, 'claude-code')).toBe(4);
      expect(sessionsPerProcessFor(defaults, 'codex')).toBe(6);
      expect(sessionsPerProcessFor(defaults, 'opencode')).toBe(4);
      expect(defaults.sessionsPerProcessByClient).toEqual({
        'claude-code': 4,
        codex: 6,
        opencode: 4,
      });
      const { pool } = executionSettingsOf(
        parseConfig('pool:\n  sessions_per_process: 5\n  codex:\n    sessions_per_process: 2\n'),
      );
      expect(sessionsPerProcessFor(pool, 'codex')).toBe(2);
      expect(sessionsPerProcessFor(pool, 'claude-code')).toBe(5);
      expect(sessionsPerProcessFor(pool, 'opencode')).toBe(4);
      // A client the settings do not name uses the global value.
      expect(sessionsPerProcessFor(pool, 'fake')).toBe(5);
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

describe('parseConfig, mcp and submit_retries (P3)', () => {
  it('defaults mcp.port to auto (N81) and takes a fixed port from 1024 to 65535', () => {
    expect(parseConfig('').mcp).toEqual({ port: 'auto' });
    expect(parseConfig('mcp:\n  port: auto\n').mcp.port).toBe('auto');
    expect(parseConfig('mcp:\n  port: 1024\n').mcp.port).toBe(1024);
    expect(parseConfig('mcp:\n  port: 65535\n').mcp.port).toBe(65535);
  });

  it('rejects a port out of range, a non-integer, any other word and unknown keys of mcp', () => {
    for (const bad of ['1023', '65536', '0', '-1', '80.5', 'random', '"8080"']) {
      expect(() => parseConfig(`mcp:\n  port: ${bad}\n`)).toThrow(/mcp\.port/);
    }
    expect(() => parseConfig('mcp:\n  host: 0.0.0.0\n')).toThrow(/host/);
  });

  it('defaults limits.submit_retries to 2 (N79) and takes any integer from 0', () => {
    expect(parseConfig('').limits.submit_retries).toBe(2);
    expect(parseConfig('limits:\n  submit_retries: 0\n').limits.submit_retries).toBe(0);
    expect(parseConfig('limits:\n  submit_retries: 5\n').limits.submit_retries).toBe(5);
    expect(() => parseConfig('limits:\n  submit_retries: -1\n')).toThrow(/submit_retries/);
    expect(() => parseConfig('limits:\n  submit_retries: 1.5\n')).toThrow(/submit_retries/);
  });
});

describe('parseConfig, directives (architecture 5.17)', () => {
  it('defaults to the Sao Paulo time zone and a notice 24 hours before the end', () => {
    const { directives } = parseConfig('');
    expect(directives.timezone).toBe('America/Sao_Paulo');
    expect(directives.expiring_notice).toBe(86_400_000);
  });

  it('takes another time zone and notice, and 0 turns the notice off', () => {
    const custom = parseConfig('directives:\n  timezone: UTC\n  expiring_notice: 2h\n');
    expect(custom.directives).toEqual({ timezone: 'UTC', expiring_notice: 7_200_000 });
    expect(parseConfig('directives:\n  expiring_notice: 0\n').directives.expiring_notice).toBe(0);
  });

  it('rejects an unknown time zone, a bad notice and unknown keys', () => {
    expect(() => parseConfig('directives:\n  timezone: Mars/Olympus\n')).toThrow(/timezone/);
    expect(() => parseConfig('directives:\n  expiring_notice: soon\n')).toThrow(/expiring_notice/);
    expect(() => parseConfig('directives:\n  other: 1\n')).toThrow(/other/);
  });
});

describe('parseConfig, prompt_queue (P7)', () => {
  it('defaults to the Producer first and ten messages in the summary', () => {
    expect(parseConfig('').prompt_queue).toEqual({ order: 'producer_first', summary_messages: 10 });
  });

  it('takes each mode of the order and any count of messages from 0', () => {
    for (const mode of PROMPT_ORDER_MODES) {
      expect(parseConfig(`prompt_queue:\n  order: ${mode}\n`).prompt_queue.order).toBe(mode);
    }
    expect(
      parseConfig('prompt_queue:\n  summary_messages: 0\n').prompt_queue.summary_messages,
    ).toBe(0);
    expect(
      parseConfig('prompt_queue:\n  summary_messages: 25\n').prompt_queue.summary_messages,
    ).toBe(25);
  });

  it('rejects an unknown mode, a bad count and unknown keys', () => {
    expect(() => parseConfig('prompt_queue:\n  order: lifo\n')).toThrow(/prompt_queue\.order/);
    for (const bad of ['-1', '1.5', '"ten"']) {
      expect(() => parseConfig(`prompt_queue:\n  summary_messages: ${bad}\n`)).toThrow(
        /summary_messages/,
      );
    }
    expect(() => parseConfig('prompt_queue:\n  size: 3\n')).toThrow(InvalidInput);
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
