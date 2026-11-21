// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, PROMPT_ORDER_MODES } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  CHAT_PRESENCE_MODES,
  RECOVERY_NOTICE_MODES,
  SANDBOX_MCP_BRIDGE_MODES,
  resolveMcpBridge,
  SANDBOX_MODES,
  CLIENT_IDS,
  LIMIT_PRESETS,
  loadConfig,
  parseConfig,
  parseDuration,
  parseTimeOfDay,
  sessionMbOf,
  sessionsPerProcessOf,
  SILENT_TURN_MODES,
  VERIFY_MODES,
} from './config.js';
import { executionSettingsOf, sessionsPerProcessFor } from './execution/settings.js';
import { makeTempDataDir } from './test-helpers.js';

describe('parseDuration / parseTimeOfDay', () => {
  it('ui.bare_command accepts tui and help, and nothing else', () => {
    expect(parseConfig('ui:\n  bare_command: help\n').ui.bare_command).toBe('help');
    expect(parseConfig('ui:\n  bare_command: tui\n').ui.bare_command).toBe('tui');
    expect(() => parseConfig('ui:\n  bare_command: gui\n')).toThrow(/ui\.bare_command/);
  });

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
    expect(config.ui.bare_command).toBe('tui');
    expect(config.log).toEqual({ level: 'info', destination: 'file' });
  });

  it('takes ui.layout.store as daemon or local, ui.layout.write_delay as a duration (P12) and ui.layout.sync as live or on_open (N174)', () => {
    expect(parseConfig('').ui.layout).toEqual({ store: 'daemon', write_delay: 300, sync: 'live' });
    expect(parseConfig('ui:\n  layout:\n    sync: on_open\n').ui.layout.sync).toBe('on_open');
    expect(() => parseConfig('ui:\n  layout:\n    sync: sometimes\n')).toThrow(/ui\.layout\.sync/);
    expect(
      parseConfig('ui:\n  layout:\n    store: local\n    write_delay: 1s\n').ui.layout,
    ).toEqual({
      store: 'local',
      write_delay: 1000,
      sync: 'live',
    });
    expect(() => parseConfig('ui:\n  layout:\n    store: cloud\n')).toThrow(/ui\.layout\.store/);
    expect(() => parseConfig('ui:\n  layout:\n    write_delay: soon\n')).toThrow(
      /ui\.layout\.write_delay/,
    );
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

  // N184 [proposta]: below the demand_timeout of each preset.
  const TURN_MINUTES = { moderate: 15, economical: 10, persistent: 25 } as const;

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
      turn_timeout: TURN_MINUTES[name as keyof typeof TURN_MINUTES] * 60_000,
      on_turn_timeout: 'cancel',
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
      turn_timeout: 600_000,
      on_turn_timeout: 'cancel',
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

  it('limits.turn_timeout (N184): preset value, own value, off, and never above demand_timeout', () => {
    expect(parseConfig('').limits).toMatchObject({
      turn_timeout: 900_000,
      on_turn_timeout: 'cancel',
    });
    expect(
      parseConfig('limits:\n  turn_timeout: 5m\n  on_turn_timeout: notice\n').limits,
    ).toMatchObject({ turn_timeout: 300_000, on_turn_timeout: 'notice' });
    expect(parseConfig('limits:\n  on_turn_timeout: off\n').limits.on_turn_timeout).toBe('off');
    // Written by the user: checked against demand_timeout (the preset's, or the user's own).
    expect(() => parseConfig('limits:\n  turn_timeout: 31m\n')).toThrow(
      /turn_timeout must not exceed demand_timeout/,
    );
    expect(() => parseConfig('limits:\n  turn_timeout: 20m\n  demand_timeout: 10m\n')).toThrow(
      /turn_timeout must not exceed demand_timeout/,
    );
    expect(parseConfig('limits:\n  turn_timeout: 30m\n').limits.turn_timeout).toBe(1_800_000);
    // The preset value alone never goes above a shorter demand_timeout of the user.
    expect(parseConfig('limits:\n  demand_timeout: 5m\n').limits.turn_timeout).toBe(300_000);
    expect(() => parseConfig('limits:\n  on_turn_timeout: stop\n')).toThrow(/on_turn_timeout/);
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
      admission: { mode: 'slots', min_free_mb: 2048, recheck: 5000, unknown_ram: 'admit' },
      'claude-code': { session_mb: 320 },
      codex: { sessions_per_process: 6, session_mb: 150 },
      opencode: { sessions_per_process: 4, session_mb: 520, process_model: 'per_profile' },
    });
    expect(config.limits).toEqual({
      preset: 'moderate',
      ...LIMIT_PRESETS.moderate,
      demand_timeout: 1_800_000,
      demand_timeout_max: 7_200_000,
      turn_timeout: 900_000,
      on_turn_timeout: 'cancel',
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

  it('takes resume.transient_exhausted and resume.client_crash_counts with the behaviour of before as default', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      const { resume } = parseConfig(`resume:\n  preset: ${preset}\n`);
      expect(resume.transient_exhausted).toBe('last');
      expect(resume.client_crash_counts).toBe('repeat');
    }
    const set = parseConfig(
      'resume:\n  transient_exhausted: handoff\n  client_crash_counts: always\n',
    ).resume;
    expect(set).toMatchObject({ transient_exhausted: 'handoff', client_crash_counts: 'always' });
    expect(parseConfig('resume:\n  client_crash_counts: never\n').resume.client_crash_counts).toBe(
      'never',
    );
    expect(() => parseConfig('resume:\n  transient_exhausted: forever\n')).toThrow(
      /transient_exhausted/,
    );
    expect(() => parseConfig('resume:\n  client_crash_counts: sometimes\n')).toThrow(
      /client_crash_counts/,
    );
  });

  it('takes the keys of the wait for the reset with the documented defaults (P19)', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      const { resume } = parseConfig(`resume:\n  preset: ${preset}\n`);
      expect(resume).toMatchObject({
        quota_wait_grace: 60_000,
        quota_wait_deadline: 'pause',
        quota_wait_counts: 'resume',
        quota_wait_missed: 'handoff',
      });
    }
    expect(
      parseConfig(
        'resume:\n  quota_wait_grace: 5m\n  quota_wait_deadline: count\n  quota_wait_counts: free\n  quota_wait_missed: park\n',
      ).resume,
    ).toMatchObject({
      quota_wait_grace: 300_000,
      quota_wait_deadline: 'count',
      quota_wait_counts: 'free',
      quota_wait_missed: 'park',
    });
    for (const key of ['quota_wait_deadline', 'quota_wait_counts', 'quota_wait_missed']) {
      expect(() => parseConfig(`resume:\n  ${key}: sometimes\n`)).toThrow(new RegExp(key));
    }
  });

  it('takes resume.on_profile_removed with the baton as default (P21b, N152)', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      expect(parseConfig(`resume:\n  preset: ${preset}\n`).resume.on_profile_removed).toBe(
        'handoff',
      );
    }
    expect(parseConfig('resume:\n  on_profile_removed: park\n').resume.on_profile_removed).toBe(
      'park',
    );
    expect(() => parseConfig('resume:\n  on_profile_removed: sometimes\n')).toThrow(
      /on_profile_removed/,
    );
  });

  it('takes resume.package with the deterministic summary as default (N126, P18)', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      expect(parseConfig(`resume:\n  preset: ${preset}\n`).resume.package).toEqual({
        summarize: 'deterministic',
        max_chars: 48_000,
        diff: 'stat',
        diff_max_chars: 12_000,
        short_output_roles: ['reviewer', 'scriptwriter', 'critic'],
        short_output: 'redo',
      });
    }
    const set = parseConfig(
      'resume:\n  package:\n    summarize: director_model\n    diff: full\n    short_output: continue\n    short_output_roles: [author]\n    max_chars: 9000\n',
    ).resume.package;
    expect(set).toMatchObject({
      summarize: 'director_model',
      diff: 'full',
      short_output: 'continue',
      short_output_roles: ['author'],
      max_chars: 9000,
      diff_max_chars: 12_000,
    });
    expect(parseConfig('resume:\n  package:\n    diff: none\n').resume.package.diff).toBe('none');
    expect(() => parseConfig('resume:\n  package:\n    summarize: gpt\n')).toThrow(/summarize/);
    expect(() => parseConfig('resume:\n  package:\n    diff: patch\n')).toThrow(/diff/);
    expect(() => parseConfig('resume:\n  package:\n    short_output: skip\n')).toThrow(
      /short_output/,
    );
    expect(() => parseConfig('resume:\n  package:\n    short_output_roles: [wizard]\n')).toThrow(
      /short_output_roles/,
    );
    expect(() => parseConfig('resume:\n  package:\n    max_chars: 10\n')).toThrow(/max_chars/);
  });

  it('defaults delivery to a PR without direct merge (N5) and takes the three modes', () => {
    expect(parseConfig('').delivery).toEqual({
      mode: 'pr',
      allow_direct_merge: false,
      base_drift: 'update',
      changelog: 'always',
      ask: { timeout: 600_000, on_leave: 'pr' },
    });
    for (const mode of ['pr', 'direct_merge', 'ask']) {
      expect(parseConfig(`delivery:\n  mode: ${mode}\n`).delivery.mode).toBe(mode);
    }
    expect(parseConfig('delivery:\n  allow_direct_merge: true\n').delivery).toEqual({
      mode: 'pr',
      allow_direct_merge: true,
      base_drift: 'update',
      changelog: 'always',
      ask: { timeout: 600_000, on_leave: 'pr' },
    });
    expect(() => parseConfig('delivery:\n  mode: merge\n')).toThrow(/mode/);
    expect(() => parseConfig('delivery:\n  allow_direct_merge: yes please\n')).toThrow(
      /allow_direct_merge/,
    );
    expect(() => parseConfig('delivery:\n  extra: 1\n')).toThrow(/extra/);
  });

  it('defaults delivery.ask to ten minutes and the PR when the Producer leaves (N89)', () => {
    expect(parseConfig('').delivery.ask).toEqual({ timeout: 600_000, on_leave: 'pr' });
    expect(parseConfig('delivery:\n  ask:\n    timeout: 90s\n').delivery.ask.timeout).toBe(90_000);
    expect(parseConfig('delivery:\n  ask:\n    timeout: 0\n').delivery.ask.timeout).toBe(0);
    for (const mode of ['pr', 'wait']) {
      expect(parseConfig(`delivery:\n  ask:\n    on_leave: ${mode}\n`).delivery.ask.on_leave).toBe(
        mode,
      );
    }
    expect(() => parseConfig('delivery:\n  ask:\n    on_leave: merge\n')).toThrow(/on_leave/);
    expect(() => parseConfig('delivery:\n  ask:\n    timeout: soon\n')).toThrow(/timeout/);
    expect(() => parseConfig('delivery:\n  ask:\n    extra: 1\n')).toThrow(/extra/);
  });

  it('defaults delivery.base_drift to update (N83) and takes the three modes', () => {
    expect(parseConfig('').delivery.base_drift).toBe('update');
    for (const mode of ['update', 'deliver_and_warn', 'ask']) {
      expect(parseConfig(`delivery:\n  base_drift: ${mode}\n`).delivery.base_drift).toBe(mode);
    }
    expect(() => parseConfig('delivery:\n  base_drift: rebase\n')).toThrow(/base_drift/);
  });

  it('defaults delivery.changelog to always (N100) and takes the three modes', () => {
    expect(parseConfig('').delivery.changelog).toBe('always');
    for (const mode of ['auto', 'always', 'never']) {
      expect(parseConfig(`delivery:\n  changelog: ${mode}\n`).delivery.changelog).toBe(mode);
    }
    expect(() => parseConfig('delivery:\n  changelog: sometimes\n')).toThrow(/changelog/);
  });

  it('defaults project.conventions to ask and takes the three modes (P7)', () => {
    expect(parseConfig('').project).toEqual({ conventions: 'ask' });
    for (const mode of ['ask', 'detect', 'off']) {
      expect(parseConfig(`project:\n  conventions: ${mode}\n`).project.conventions).toBe(mode);
    }
    expect(() => parseConfig('project:\n  conventions: guess\n')).toThrow(/conventions/);
    expect(() => parseConfig('project:\n  extra: 1\n')).toThrow(/extra/);
  });

  it('defaults integration.rebase_conflict to redo (N82) and takes the three modes', () => {
    expect(parseConfig('').integration).toEqual({ rebase_conflict: 'redo' });
    for (const mode of ['redo', 'script_failure', 'resolve_attempt']) {
      expect(
        parseConfig(`integration:\n  rebase_conflict: ${mode}\n`).integration.rebase_conflict,
      ).toBe(mode);
    }
    expect(() => parseConfig('integration:\n  rebase_conflict: ignore\n')).toThrow(
      /rebase_conflict/,
    );
    expect(() => parseConfig('integration:\n  extra: 1\n')).toThrow(/extra/);
  });

  it('defaults rescript.reuse to keep_unchanged (N84) and takes the three modes', () => {
    expect(parseConfig('').rescript).toEqual({ reuse: 'keep_unchanged' });
    for (const mode of ['keep_unchanged', 'redo_all', 'from_previous']) {
      expect(parseConfig(`rescript:\n  reuse: ${mode}\n`).rescript.reuse).toBe(mode);
    }
    expect(() => parseConfig('rescript:\n  reuse: always\n')).toThrow(/reuse/);
    expect(() => parseConfig('rescript:\n  extra: 1\n')).toThrow(/extra/);
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

describe('parseConfig, pool.admission and session_mb (Phase 5, P4)', () => {
  it('defaults to the behaviour from before P4 (mode slots)', () => {
    expect(parseConfig('').pool.admission.mode).toBe('slots');
  });

  it('takes the three modes of pool.admission.mode and rejects any other', () => {
    for (const mode of ['slots', 'ram', 'ram_and_quota']) {
      expect(parseConfig(`pool:\n  admission:\n    mode: ${mode}\n`).pool.admission.mode).toBe(
        mode,
      );
    }
    expect(() => parseConfig('pool:\n  admission:\n    mode: quota\n')).toThrow(/mode/);
  });

  it('reads min_free_mb, recheck and unknown_ram, and refuses nonsense', () => {
    const admission = parseConfig(
      'pool:\n  admission:\n    min_free_mb: 4096\n    recheck: 10s\n    unknown_ram: wait\n',
    ).pool.admission;
    expect(admission).toMatchObject({ min_free_mb: 4096, recheck: 10_000, unknown_ram: 'wait' });
    expect(() => parseConfig('pool:\n  admission:\n    min_free_mb: -1\n')).toThrow(/min_free_mb/);
    expect(() => parseConfig('pool:\n  admission:\n    recheck: 0s\n')).toThrow(/recheck/);
    expect(() => parseConfig('pool:\n  admission:\n    unknown_ram: maybe\n')).toThrow(
      /unknown_ram/,
    );
    expect(() => parseConfig('pool:\n  admission:\n    other: 1\n')).toThrow(InvalidInput);
  });

  it('has a session_mb per client from the N74 measurement, and takes a number or auto', () => {
    const { pool } = parseConfig('');
    expect(pool['claude-code'].session_mb).toBe(320);
    expect(pool.codex.session_mb).toBe(150);
    expect(pool.opencode.session_mb).toBe(520);
    const set = parseConfig(
      'pool:\n  codex:\n    session_mb: auto\n  opencode:\n    session_mb: 900\n',
    ).pool;
    expect(set.codex.session_mb).toBe('auto');
    expect(set.opencode.session_mb).toBe(900);
    expect(sessionMbOf(set, 'codex')).toBe('auto');
    expect(() => parseConfig('pool:\n  codex:\n    session_mb: 0\n')).toThrow(/session_mb/);
    expect(() => parseConfig('pool:\n  codex:\n    session_mb: big\n')).toThrow(/session_mb/);
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

describe('parseConfig, scenarios (architecture 5.20)', () => {
  it('defaults: 15 minutes to sleep, 50 MB per attachment, 8 MB per read, no alternatives', () => {
    const { scenarios } = parseConfig('');
    expect(scenarios.director_idle_after).toBe(900_000);
    expect(scenarios.attachment_max_size).toBe(50 * 1024 * 1024);
    expect(scenarios.attachment_read_max).toBe(8 * 1024 * 1024);
    expect(scenarios.consultant_alternatives).toEqual([]);
  });

  it('takes the modes: never sleep, no limit, sizes and alternatives', () => {
    const custom = parseConfig(
      'scenarios:\n  director_idle_after: 0\n  attachment_max_size: 0\n  attachment_read_max: 512KB\n' +
        '  consultant_alternatives:\n    - { client: codex, profile: p, model: m }\n',
    );
    expect(custom.scenarios.director_idle_after).toBe(0);
    expect(custom.scenarios.attachment_max_size).toBe(0);
    expect(custom.scenarios.attachment_read_max).toBe(512 * 1024);
    expect(custom.scenarios.consultant_alternatives).toEqual([
      { client: 'codex', profile: 'p', model: 'm' },
    ]);
    expect(
      parseConfig('scenarios:\n  director_idle_after: 2h\n').scenarios.director_idle_after,
    ).toBe(7_200_000);
  });

  it('consultant_writes defaults to merge and takes merge, keep and discard (P10)', () => {
    expect(parseConfig('').scenarios.consultant_writes).toBe('merge');
    for (const mode of ['merge', 'keep', 'discard'] as const) {
      expect(
        parseConfig(`scenarios:\n  consultant_writes: ${mode}\n`).scenarios.consultant_writes,
      ).toBe(mode);
    }
    expect(() => parseConfig('scenarios:\n  consultant_writes: always\n')).toThrow(
      /consultant_writes/,
    );
  });

  it('director_failover defaults to next and takes next, quota_only and off (P20)', () => {
    expect(parseConfig('').scenarios.director_failover).toBe('next');
    for (const mode of ['next', 'quota_only', 'off'] as const) {
      expect(
        parseConfig(`scenarios:\n  director_failover: ${mode}\n`).scenarios.director_failover,
      ).toBe(mode);
    }
    expect(() => parseConfig('scenarios:\n  director_failover: always\n')).toThrow(
      /director_failover/,
    );
  });

  it('rejects a bad duration, a bad size and an unknown key', () => {
    expect(() => parseConfig('scenarios:\n  director_idle_after: soon\n')).toThrow(
      /director_idle_after/,
    );
    expect(() => parseConfig('scenarios:\n  attachment_max_size: big\n')).toThrow(
      /attachment_max_size/,
    );
    expect(() => parseConfig('scenarios:\n  other: 1\n')).toThrow(/other/);
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

describe('orchestration', () => {
  it('defaults to no Executor, no role overrides and running the verify steps', () => {
    expect(parseConfig('').orchestration).toEqual({ roles: {}, verify: 'run' });
  });

  it('reads the Executor of the plays and one per role', () => {
    const { orchestration } = parseConfig(
      [
        'orchestration:',
        '  executor: { client: claude-code, profile: work, model: sonnet, effort: high }',
        '  roles:',
        '    critic: { client: codex, profile: alt, model: gpt }',
      ].join('\n'),
    );
    expect(orchestration.executor).toEqual({
      client: 'claude-code',
      profile: 'work',
      model: 'sonnet',
      effort: 'high',
    });
    expect(orchestration.roles.critic?.client).toBe('codex');
  });

  it('takes each mode of verify', () => {
    for (const mode of VERIFY_MODES) {
      expect(parseConfig(`orchestration:\n  verify: ${mode}\n`).orchestration.verify).toBe(mode);
    }
  });

  it('rejects a bad mode, an incomplete Executor and unknown keys', () => {
    expect(() => parseConfig('orchestration:\n  verify: maybe\n')).toThrow(/orchestration\.verify/);
    expect(() => parseConfig('orchestration:\n  executor: { client: codex }\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('orchestration:\n  mode: fast\n')).toThrow(InvalidInput);
  });
});

describe('chat', () => {
  it('defaults to 200 replies of history', () => {
    expect(parseConfig('').chat).toEqual({
      history: 200,
      presence: 'connected',
      presence_window: 30_000,
      silent_turn: 'notice',
    });
  });

  it('takes each silent_turn mode and refuses any other (N183)', () => {
    expect(SILENT_TURN_MODES).toEqual(['notice', 'none']);
    for (const mode of SILENT_TURN_MODES) {
      expect(parseConfig(`chat:\n  silent_turn: ${mode}\n`).chat.silent_turn).toBe(mode);
    }
    expect(() => parseConfig('chat:\n  silent_turn: loud\n')).toThrow(/chat\.silent_turn/);
  });

  it('takes any history from 1', () => {
    expect(parseConfig('chat:\n  history: 1\n').chat.history).toBe(1);
  });

  it('takes each presence mode, and refuses the old name `poll` (N175, no alias)', () => {
    expect(CHAT_PRESENCE_MODES).toEqual(['connected', 'always', 'never']);
    for (const mode of CHAT_PRESENCE_MODES) {
      expect(parseConfig(`chat:\n  presence: ${mode}\n`).chat.presence).toBe(mode);
    }
    let message = '';
    try {
      parseConfig('chat:\n  presence: poll\n');
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/chat\.presence/);
    for (const mode of CHAT_PRESENCE_MODES) expect(message).toContain(mode);
  });

  it('rejects a bad history and unknown keys (the old `channel` key included)', () => {
    expect(() => parseConfig('chat:\n  channel: auto\n')).toThrow(InvalidInput);
    for (const bad of ['0', '1.5', '"all"']) {
      expect(() => parseConfig(`chat:\n  history: ${bad}\n`)).toThrow(/history/);
    }
    expect(() => parseConfig('chat:\n  port: 80\n')).toThrow(InvalidInput);
  });
});

describe('recovery', () => {
  it('tells the chat on every start-up that took something up, by default', () => {
    expect(parseConfig('').recovery).toEqual({ notice: 'always' });
  });

  it('takes each mode of the notice', () => {
    for (const mode of RECOVERY_NOTICE_MODES) {
      expect(parseConfig(`recovery:\n  notice: ${mode}\n`).recovery.notice).toBe(mode);
    }
  });

  it('rejects an unknown mode and unknown keys', () => {
    expect(() => parseConfig('recovery:\n  notice: sometimes\n')).toThrow(/recovery\.notice/);
    expect(() => parseConfig('recovery:\n  chat: true\n')).toThrow(InvalidInput);
  });
});

describe('sandbox.mcp_bridge (N115, N161)', () => {
  it('bridges the MCP server of the daemon into the sandbox by default, and takes each mode', () => {
    expect(parseConfig('').sandbox.mcp_bridge).toBe('auto');
    expect(SANDBOX_MCP_BRIDGE_MODES).toEqual(['auto', 'proxy', 'unix', 'off']);
    for (const mode of SANDBOX_MCP_BRIDGE_MODES) {
      expect(parseConfig(`sandbox:\n  mcp_bridge: ${mode}\n`).sandbox.mcp_bridge).toBe(mode);
    }
  });

  it('rejects a mode that does not exist', () => {
    expect(() => parseConfig('sandbox:\n  mcp_bridge: socket\n')).toThrow(/sandbox\.mcp_bridge/);
  });

  it('resolves auto per platform, and refuses unix where the sandbox blocks Unix sockets', () => {
    expect(resolveMcpBridge('auto', 'darwin')).toBe('unix');
    expect(resolveMcpBridge('auto', 'linux')).toBe('proxy');
    expect(resolveMcpBridge('proxy', 'darwin')).toBe('proxy');
    expect(resolveMcpBridge('off', 'linux')).toBe('off');
    expect(resolveMcpBridge('unix', 'darwin')).toBe('unix');
    expect(() => resolveMcpBridge('unix', 'linux')).toThrow(/macOS only/);
  });
});

describe('sandbox and security.secret_paths', () => {
  it('turns layer 3 on by default where an adapter exists, with nothing extra', () => {
    expect(parseConfig('').sandbox).toEqual({
      mode: 'runtime',
      extra_write_paths: [],
      extra_domains: [],
      mcp_bridge: 'auto',
    });
    expect(parseConfig('').security.secret_paths).toEqual({ add: [], remove: [] });
    expect(SANDBOX_MODES).toEqual(['runtime', 'off']);
  });

  it('takes each mode and the extra folders and domains', () => {
    for (const mode of SANDBOX_MODES) {
      expect(parseConfig(`sandbox:\n  mode: ${mode}\n`).sandbox.mode).toBe(mode);
    }
    const { sandbox } = parseConfig(
      'sandbox:\n  extra_write_paths: [/var/cache/x]\n  extra_domains: [registry.npmjs.org]\n',
    );
    expect(sandbox.extra_write_paths).toEqual(['/var/cache/x']);
    expect(sandbox.extra_domains).toEqual(['registry.npmjs.org']);
  });

  it('rejects an unknown mode, a relative folder and unknown keys', () => {
    expect(() => parseConfig('sandbox:\n  mode: docker\n')).toThrow(/sandbox\.mode/);
    expect(() => parseConfig('sandbox:\n  extra_write_paths: [cache]\n')).toThrow(
      /sandbox\.extra_write_paths/,
    );
    expect(() => parseConfig('sandbox:\n  other: 1\n')).toThrow(InvalidInput);
  });

  it('adds to and removes from the secret paths', () => {
    const { secret_paths } = parseConfig(
      'security:\n  secret_paths:\n    add: ["~/.vault"]\n    remove: ["~/.aws"]\n',
    ).security;
    expect(secret_paths).toEqual({ add: ['~/.vault'], remove: ['~/.aws'] });
    expect(() => parseConfig('security:\n  secret_paths:\n    add: [""]\n')).toThrow(InvalidInput);
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
