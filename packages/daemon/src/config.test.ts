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
  CLIENT_COMMAND_MODES,
  SLASH_ACCESS_MODES,
  SLASH_COMMAND_MODES,
  SLASH_CONFIRM_MODES,
  VERIFY_MODES,
} from './config.js';
import { PLUGIN_INSTALL_SOURCES } from './plugins/install-sources.js';
import {
  PLUGIN_APPROVAL_DETAIL_MODES,
  PLUGIN_EXTERNAL_WRITE_APPROVAL_MODES,
  PLUGIN_EXTERNAL_WRITE_MODES,
  PLUGIN_LOCAL_WRITE_MODES,
  PLUGIN_NETWORK_MODES,
} from './plugins/permissions.js';
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
      telemetry: 'exclude',
      method: 'online_api',
      pages_per_step: 'all',
    });
    expect(config.ui.locale).toBe('auto');
    expect(config.ui.bare_command).toBe('tui');
    expect(config.log).toEqual({
      level: 'info',
      destination: 'file',
      rotate: { mode: 'size', max_mb: 20, keep: 5 },
    });
  });

  it('has the defaults of ui.keymap, ui.clipboard, ui.mouse, ui.render and ui.runtime (N34 to N37)', () => {
    const { ui } = parseConfig('');
    expect(ui.keymap).toEqual({ preset: 'agents', environment: 'auto', overrides: {} });
    expect(ui.clipboard).toEqual({ copy: 'osc52' });
    expect(ui.mouse).toBe('full');
    expect(ui.render).toEqual({
      keyRender: 'flush',
      maxFps: 30,
      coalesceMs: 16,
      memo: true,
      inkPatches: ['cache', 'grid'],
      historyWindow: 0,
    });
    expect(ui.runtime).toEqual({ maxSemiSpaceMB: 2, exitGraceMs: 2000 });
    expect(ui.runtime.maxOldSpaceMB).toBeUndefined();
    expect(ui.tuiLayout).toEqual({
      sidebarWidth: 30,
      railWidth: 5,
      minChatWidth: 30,
      minPanelWidth: 30,
      chatStep: 2,
      scrollStep: 'half',
    });
  });

  it('has the defaults of ui.tuiMouse, takes the auto copy mode and refuses bad values (P11)', () => {
    expect(parseConfig('').ui.tuiMouse).toEqual({ wheelLines: 3, copyMaxBytes: 100_000 });
    const yaml = 'ui:\n  clipboard:\n    copy: auto\n  tuiMouse:\n    wheelLines: 5\n';
    const { ui } = parseConfig(yaml);
    expect(ui.clipboard.copy).toBe('auto');
    expect(ui.tuiMouse).toEqual({ wheelLines: 5, copyMaxBytes: 100_000 });
    expect(() => parseConfig('ui:\n  tuiMouse:\n    wheelLines: 0\n')).toThrow(
      /ui\.tuiMouse\.wheelLines/,
    );
    expect(() => parseConfig('ui:\n  tuiMouse:\n    speed: 1\n')).toThrow(/ui\.tuiMouse/);
  });

  it('has the default of ui.sidebar, takes its modes and refuses bad values (P11)', () => {
    expect(parseConfig('').ui.sidebar).toEqual({ finishedPlays: 'collapsed', finishedLimit: 20 });
    for (const mode of ['collapsed', 'hidden', 'expanded']) {
      expect(
        parseConfig(`ui:\n  sidebar:\n    finishedPlays: ${mode}\n`).ui.sidebar.finishedPlays,
      ).toBe(mode);
    }
    expect(parseConfig('ui:\n  sidebar:\n    finishedLimit: 100\n').ui.sidebar.finishedLimit).toBe(
      100,
    );
    expect(() => parseConfig('ui:\n  sidebar:\n    finishedPlays: always\n')).toThrow(
      /ui\.sidebar\.finishedPlays/,
    );
    expect(() => parseConfig('ui:\n  sidebar:\n    finishedLimit: 0\n')).toThrow(
      /ui\.sidebar\.finishedLimit/,
    );
    expect(() => parseConfig('ui:\n  sidebar:\n    other: 1\n')).toThrow();
  });

  it('has the default of ui.newProject, takes its other modes and refuses bad values (P22)', () => {
    expect(parseConfig('').ui.newProject).toEqual({ repo: 'cwd' });
    expect(parseConfig('ui:\n  newProject:\n    repo: git_root\n').ui.newProject.repo).toBe(
      'git_root',
    );
    expect(parseConfig('ui:\n  newProject:\n    repo: empty\n').ui.newProject.repo).toBe('empty');
    expect(() => parseConfig('ui:\n  newProject:\n    repo: home\n')).toThrow(
      /ui\.newProject\.repo/,
    );
  });

  it('has the defaults of ui.setup, takes its other mode and refuses bad values (P17)', () => {
    expect(parseConfig('').ui.setup).toEqual({ open: 'auto', readTimeoutMs: 5000 });
    const { ui } = parseConfig('ui:\n  setup:\n    open: never\n    readTimeoutMs: 800\n');
    expect(ui.setup).toEqual({ open: 'never', readTimeoutMs: 800 });
    expect(() => parseConfig('ui:\n  setup:\n    open: always\n')).toThrow(/ui\.setup\.open/);
    expect(() => parseConfig('ui:\n  setup:\n    wait: 1\n')).toThrow(/ui\.setup/);
  });

  it('has the defaults of ui.input and takes its other modes (N35)', () => {
    expect(parseConfig('').ui.input).toEqual({
      paste: { mode: 'marker', lines: 10, chars: 2000 },
      dropPaths: 'attach',
      history: { store: 'file', size: 500 },
      editor: 'auto',
      maxVisibleLines: 8,
      image: { tool: 'auto', timeoutMs: 3000, maxBytes: 20 * 1024 * 1024 },
    });
    const yaml = 'ui:\n  input:\n    history:\n      store: memory\n    image:\n      tool: off\n';
    const { input } = parseConfig(yaml).ui;
    expect(input.history).toEqual({ store: 'memory', size: 500 });
    expect(input.image.tool).toBe('off');
    expect(() => parseConfig('ui:\n  input:\n    editor: vim\n')).toThrow(/ui\.input\.editor/);
  });

  it('has the defaults of ui.chat and takes its other modes (P12)', () => {
    expect(parseConfig('').ui.chat).toEqual({
      queue: 'daemon',
      suggestions: 6,
      decisionFocus: 'auto',
      decisionClick: 'answer',
      esc: 'stop',
      directorFooter: 'on',
      history: 40,
    });
    const yaml =
      'ui:\n  chat:\n    queue: hold\n    suggestions: 0\n    esc: off\n    decisionClick: select\n';
    expect(parseConfig(yaml).ui.chat).toEqual({
      queue: 'hold',
      suggestions: 0,
      decisionFocus: 'auto',
      decisionClick: 'select',
      esc: 'off',
      directorFooter: 'on',
      history: 40,
    });
    expect(parseConfig('ui:\n  chat:\n    directorFooter: off\n').ui.chat.directorFooter).toBe(
      'off',
    );
    expect(() => parseConfig('ui:\n  chat:\n    directorFooter: maybe\n')).toThrow(
      /ui\.chat\.directorFooter/,
    );
    expect(() => parseConfig('ui:\n  chat:\n    decisionClick: double\n')).toThrow(
      /ui\.chat\.decisionClick/,
    );
    expect(parseConfig('ui:\n  chat:\n    history: 0\n').ui.chat.history).toBe(0);
    expect(() => parseConfig('ui:\n  chat:\n    history: 201\n')).toThrow(/ui\.chat\.history/);
    expect(() => parseConfig('ui:\n  chat:\n    queue: later\n')).toThrow(/ui\.chat\.queue/);
  });

  it('has the defaults of ui.overview and ui.usage and takes their other modes (P13)', () => {
    const { ui } = parseConfig('');
    expect(ui.overview).toEqual({
      confirm: 'always',
      recentEvents: 8,
      hiddenEvents: ['session.update'],
    });
    expect(ui.usage).toEqual({
      groupBy: 'profile',
      refreshSeconds: 30,
      sections: ['totals', 'groups', 'budget', 'trend', 'bottlenecks', 'play', 'telemetry'],
      trendDays: 14,
      spanRows: 40,
    });
    const yaml =
      'ui:\n  overview:\n    confirm: off\n  usage:\n    groupBy: executor\n    refreshSeconds: 0\n';
    expect(parseConfig(yaml).ui.overview.confirm).toBe('off');
    expect(parseConfig(yaml).ui.usage.groupBy).toBe('executor');
    expect(parseConfig(yaml).ui.usage.refreshSeconds).toBe(0);
    expect(() => parseConfig('ui:\n  usage:\n    groupBy: day\n')).toThrow(/ui\.usage\.groupBy/);
    // P10: the sections of the tab, the days of the trend and the rows of the tree of spans
    const panels = parseConfig(
      'ui:\n  usage:\n    sections: [telemetry, totals]\n    trendDays: 30\n    spanRows: 100\n',
    ).ui.usage;
    expect(panels.sections).toEqual(['telemetry', 'totals']);
    expect(panels.trendDays).toBe(30);
    expect(panels.spanRows).toBe(100);
    expect(() => parseConfig('ui:\n  usage:\n    sections: [costs]\n')).toThrow(
      /ui\.usage\.sections/,
    );
    expect(() => parseConfig('ui:\n  usage:\n    trendDays: 0\n')).toThrow(/ui\.usage\.trendDays/);
  });

  it('takes the other modes of the ui.* keys of the terminal and refuses bad values', () => {
    const yaml = [
      'ui:',
      '  keymap:',
      '    preset: classic',
      '    overrides:',
      '      layout.toggleSidebar: Alt+Z',
      '      tabs.add: [Alt+T, F7]',
      '      layout.togglePanel: []',
      '  clipboard:',
      '    copy: system',
      '  mouse: wheel',
      '  render:',
      '    keyRender: throttle',
      '    maxFps: 60',
      '    inkPatches: []',
      '  runtime:',
      '    maxOldSpaceMB: 512',
      '',
    ].join('\n');
    const { ui } = parseConfig(yaml);
    expect(ui.keymap.preset).toBe('classic');
    expect(ui.keymap.overrides).toEqual({
      'layout.toggleSidebar': 'Alt+Z',
      'tabs.add': ['Alt+T', 'F7'],
      'layout.togglePanel': [],
    });
    expect(ui.clipboard.copy).toBe('system');
    expect(ui.mouse).toBe('wheel');
    expect(ui.render).toMatchObject({ keyRender: 'throttle', maxFps: 60, inkPatches: [] });
    expect(ui.runtime.maxOldSpaceMB).toBe(512);
    expect(() => parseConfig('ui:\n  clipboard:\n    copy: paste\n')).toThrow(
      /ui\.clipboard\.copy/,
    );
    expect(() => parseConfig('ui:\n  mouse: some\n')).toThrow(/ui\.mouse/);
    expect(() => parseConfig('ui:\n  render:\n    maxFps: 0\n')).toThrow(/ui\.render\.maxFps/);
    expect(() => parseConfig('ui:\n  render:\n    speed: 1\n')).toThrow(/ui\.render/);
    expect(() => parseConfig('ui:\n  runtime:\n    maxSemiSpaceMB: 0\n')).toThrow(
      /ui\.runtime\.maxSemiSpaceMB/,
    );
    expect(() => parseConfig('ui:\n  keymap:\n    preset: vim\n')).toThrow(/ui\.keymap\.preset/);
  });

  it('refuses at start-up a ui.keymap with a repeated shortcut, an unknown action or a key a terminal cannot send', () => {
    const overrides = (lines: string) => `ui:\n  keymap:\n    overrides:\n${lines}`;
    // the same shortcut as another action (Alt+S is the side bar)
    expect(() => parseConfig(overrides('      tabs.add: Alt+S\n'))).toThrow(
      /ui\.keymap\.overrides\.tabs\.add.*Alt\+S/s,
    );
    // twice in one action
    expect(() => parseConfig(overrides('      tabs.add: [Alt+Q, alt+q]\n'))).toThrow(/Alt\+Q/);
    expect(() => parseConfig(overrides('      nope.nothing: Alt+Q\n'))).toThrow(/nope\.nothing/);
    expect(() => parseConfig(overrides('      tabs.add: Cmd+T\n'))).toThrow(/Cmd/);
    expect(() => parseConfig(overrides('      tabs.add: Alt+Foo\n'))).toThrow(/key combination/);
    // a shortcut on the list of collisions only warns: the config loads
    expect(parseConfig(overrides('      tabs.add: Ctrl+T\n')).ui.keymap.overrides['tabs.add']).toBe(
      'Ctrl+T',
    );
    // moving two shortcuts around is fine
    expect(() =>
      parseConfig(
        overrides('      layout.toggleSidebar: Alt+J\n      layout.togglePanel: Alt+S\n'),
      ),
    ).not.toThrow();
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

  it('defaults pause.mode to drain (N176) and takes the two modes', () => {
    expect(parseConfig('').pause).toEqual({ mode: 'drain' });
    expect(parseConfig('pause:\n  mode: interrupt\n').pause.mode).toBe('interrupt');
    expect(() => parseConfig('pause:\n  mode: kill\n')).toThrow(/mode/);
    expect(() => parseConfig('pause:\n  extra: 1\n')).toThrow(/extra/);
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

  it('scenarios.director_switch.in_turn: wait by default, interrupt on request (P14, N242)', () => {
    expect(parseConfig('').scenarios.director_switch.in_turn).toBe('wait');
    for (const mode of ['wait', 'interrupt'] as const) {
      expect(
        parseConfig(`scenarios:\n  director_switch:\n    in_turn: ${mode}\n`).scenarios
          .director_switch.in_turn,
      ).toBe(mode);
    }
    expect(() => parseConfig('scenarios:\n  director_switch:\n    in_turn: never\n')).toThrow(
      /in_turn/,
    );
    expect(() => parseConfig('scenarios:\n  director_switch:\n    other: 1\n')).toThrow(/other/);
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

describe('parseConfig, plugins (Phase 9, P5)', () => {
  it('defaults to ten minutes idle, three restarts and a minute per call', () => {
    expect(parseConfig('').plugins).toEqual({
      idle_timeout: 600_000,
      max_restarts: 3,
      call_timeout: 60_000,
      start_timeout: 30_000,
      restart_backoff: { initial: 1_000, max: 60_000 },
      http: 'loopback',
      events: 'declared',
      event_max_bytes: 16_384,
      panel: { max_rows: 200, max_bytes: 1_048_576 },
      install: { sources: [...PLUGIN_INSTALL_SOURCES], timeout: 300_000, npm: 'auto' },
      permissions: {
        local_write: 'writes',
        network: 'network_allow',
        external_write: 'writes',
        external_write_approval: 'ask',
        approval_detail: 'keys',
      },
    });
  });

  it('takes durations, off for the idle timeout, and each mode of http', () => {
    const plugins = parseConfig(
      'plugins:\n  idle_timeout: off\n  call_timeout: 90s\n  max_restarts: 0\n  http: off\n  restart_backoff:\n    initial: 500ms\n    max: 10s\n',
    ).plugins;
    expect(plugins.idle_timeout).toBeNull();
    expect(plugins.call_timeout).toBe(90_000);
    expect(plugins.max_restarts).toBe(0);
    expect(plugins.http).toBe('off');
    expect(plugins.restart_backoff).toEqual({ initial: 500, max: 10_000 });
    expect(parseConfig('plugins:\n  idle_timeout: 2h\n').plugins.idle_timeout).toBe(7_200_000);
  });

  it('rejects a bad value and unknown keys', () => {
    expect(() => parseConfig('plugins:\n  http: any\n')).toThrow(/plugins\.http/);
    expect(() => parseConfig('plugins:\n  max_restarts: -1\n')).toThrow(/max_restarts/);
    expect(() => parseConfig('plugins:\n  max_restarts: 1.5\n')).toThrow(/max_restarts/);
    expect(() => parseConfig('plugins:\n  call_timeout: soon\n')).toThrow(/call_timeout/);
    expect(() => parseConfig('plugins:\n  pool: 3\n')).toThrow(InvalidInput);
  });
});

describe('parseConfig, plugins events (Phase 9, P8)', () => {
  it('takes each mode of events and a size for the payload', () => {
    expect(parseConfig('plugins:\n  events: off\n').plugins.events).toBe('off');
    expect(parseConfig('plugins:\n  event_max_bytes: 4096\n').plugins.event_max_bytes).toBe(4096);
  });

  it('rejects an unknown mode and a size that is not a positive count of bytes', () => {
    expect(() => parseConfig('plugins:\n  events: any\n')).toThrow(/plugins\.events/);
    for (const bad of ['0', '-1', '1.5', '2000000', '"big"']) {
      expect(() => parseConfig(`plugins:\n  event_max_bytes: ${bad}\n`)).toThrow(/event_max_bytes/);
    }
  });
});

describe('parseConfig, plugins panel (Phase 9, P10)', () => {
  it('takes a row limit and a size or off for the bytes of a block', () => {
    expect(parseConfig('plugins:\n  panel:\n    max_rows: 50\n').plugins.panel.max_rows).toBe(50);
    expect(parseConfig('plugins:\n  panel:\n    max_bytes: 64KB\n').plugins.panel.max_bytes).toBe(
      65_536,
    );
    expect(
      parseConfig('plugins:\n  panel:\n    max_bytes: off\n').plugins.panel.max_bytes,
    ).toBeNull();
  });

  it('rejects a limit that is not a positive count, a size of zero and a key it does not know', () => {
    for (const bad of ['0', '-1', '1.5', '100001', '"many"']) {
      expect(() => parseConfig(`plugins:\n  panel:\n    max_rows: ${bad}\n`)).toThrow(/max_rows/);
    }
    expect(() => parseConfig('plugins:\n  panel:\n    max_bytes: 0B\n')).toThrow(/max_bytes/);
    expect(() => parseConfig('plugins:\n  panel:\n    max_bytes: lots\n')).toThrow(/max_bytes/);
    expect(() => parseConfig('plugins:\n  panel:\n    pages: 3\n')).toThrow(InvalidInput);
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
      slash_commands: 'on',
      client_commands: 'on',
      client_commands_allow: [],
      slash_confirm: 'always',
      slash_logs_lines: 20,
      slash_access: 'full',
      slash_templates: {
        plan: 'Make a plan, without changing anything yet, for: ',
        explain: 'Explain: ',
        review: 'Review the work done so far and tell me what is missing: ',
      },
      shell_command: { mode: 'on', timeout: 300_000, context: 'auto', max_running: 4 },
    });
  });

  it('takes each mode of the / commands and refuses any other (P3)', () => {
    expect(SLASH_COMMAND_MODES).toEqual(['on', 'off']);
    expect(CLIENT_COMMAND_MODES).toEqual(['on', 'off', 'allowlist']);
    expect(SLASH_CONFIRM_MODES).toEqual(['always', 'never']);
    expect(SLASH_ACCESS_MODES).toEqual(['full', 'read_only']);
    for (const [key, modes] of [
      ['slash_commands', SLASH_COMMAND_MODES],
      ['client_commands', CLIENT_COMMAND_MODES],
      ['slash_confirm', SLASH_CONFIRM_MODES],
      ['slash_access', SLASH_ACCESS_MODES],
    ] as const) {
      for (const mode of modes) {
        expect(parseConfig(`chat:\n  ${key}: ${mode}\n`).chat[key]).toBe(mode);
      }
      expect(() => parseConfig(`chat:\n  ${key}: loud\n`)).toThrow(new RegExp(`chat\\.${key}`));
    }
    expect(parseConfig('chat:\n  slash_logs_lines: 500\n').chat.slash_logs_lines).toBe(500);
    expect(() => parseConfig('chat:\n  slash_logs_lines: 501\n')).toThrow(/slash_logs_lines/);
    expect(() => parseConfig('chat:\n  slash_templates:\n    Bad Name: x\n')).toThrow(
      /slash_templates/,
    );
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

describe('the ! command (N43, N187)', () => {
  it('is on, with a 5 minute timeout and the output going to the Director by default', () => {
    const config = parseConfig('');
    expect(config.chat.shell_command).toEqual({
      mode: 'on',
      timeout: 300_000,
      context: 'auto',
      max_running: 4,
    });
    expect(config.app).toEqual({ terminal: 'sandbox' });
    expect(config.terminal).toEqual({
      snippet: { max_lines: 200, keep: 'tail' },
      log_max_size: 16 * 1024 * 1024,
    });
  });

  it('takes chat.shell_command as the scalar on | off or as a section', () => {
    expect(parseConfig('chat:\n  shell_command: off\n').chat.shell_command).toEqual({
      mode: 'off',
      timeout: 300_000,
      context: 'auto',
      max_running: 4,
    });
    expect(
      parseConfig('chat:\n  shell_command:\n    timeout: 30s\n    context: ask\n').chat
        .shell_command,
    ).toEqual({ mode: 'on', timeout: 30_000, context: 'ask', max_running: 4 });
    expect(
      parseConfig('chat:\n  shell_command: { timeout: off }\n').chat.shell_command.timeout,
    ).toBe(null);
  });

  it('refuses a bad mode, timeout, context, terminal mode or snippet size', () => {
    for (const bad of [
      'chat:\n  shell_command: maybe\n',
      'chat:\n  shell_command: { timeout: 0 }\n',
      'chat:\n  shell_command: { timeout: soon }\n',
      'chat:\n  shell_command: { context: sometimes }\n',
      'chat:\n  shell_command: { other: 1 }\n',
      'chat:\n  shell_command: { max_running: 0 }\n',
      'app:\n  terminal: docker\n',
      'terminal:\n  snippet: { max_lines: 0 }\n',
      'terminal:\n  snippet: { keep: middle }\n',
      'terminal:\n  log_max_size: 0B\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
  });

  it('takes each app.terminal mode and the snippet keys', () => {
    for (const mode of ['sandbox', 'host', 'off']) {
      expect(parseConfig(`app:\n  terminal: ${mode}\n`).app.terminal).toBe(mode);
    }
    const terminal = parseConfig(
      'terminal:\n  snippet: { max_lines: 5, keep: head }\n  log_max_size: 1MB\n',
    ).terminal;
    expect(terminal).toEqual({ snippet: { max_lines: 5, keep: 'head' }, log_max_size: 1_048_576 });
  });
});

describe('the direct session (P19, N44, N190)', () => {
  it('opens in its own worktree by default, asks for the scenario and times out at 30 minutes', () => {
    expect(parseConfig('').direct_session).toEqual({
      workspace: 'worktree',
      confirm_scenario: 'ask',
      max_open: 3,
      on_close: 'keep',
      history_max: 200,
      closed_kept: 10,
      idle_timeout: 1_800_000,
      orphans: 'on_close',
    });
  });

  it('takes each workspace, confirm and close mode and the idle timeout', () => {
    for (const workspace of ['worktree', 'readonly', 'scenario']) {
      expect(
        parseConfig(`direct_session:\n  workspace: ${workspace}\n`).direct_session.workspace,
      ).toBe(workspace);
    }
    const section = parseConfig(
      'direct_session:\n  confirm_scenario: never\n  on_close: discard\n  max_open: 1\n  idle_timeout: off\n',
    ).direct_session;
    expect(section).toMatchObject({
      confirm_scenario: 'never',
      on_close: 'discard',
      max_open: 1,
      idle_timeout: null,
    });
    for (const orphans of ['on_close', 'keep', 'discard', 'off']) {
      expect(parseConfig(`direct_session:\n  orphans: ${orphans}\n`).direct_session.orphans).toBe(
        orphans,
      );
    }
  });

  it('refuses a bad mode, size or key', () => {
    for (const bad of [
      'direct_session:\n  workspace: host\n',
      'direct_session:\n  confirm_scenario: maybe\n',
      'direct_session:\n  on_close: move\n',
      'direct_session:\n  max_open: 0\n',
      'direct_session:\n  history_max: 0\n',
      'direct_session:\n  closed_kept: -1\n',
      'direct_session:\n  idle_timeout: soon\n',
      'direct_session:\n  orphans: sometimes\n',
      'direct_session:\n  other: 1\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
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

describe('setup (the setup assistant, P4 of Phase 7)', () => {
  it('proposes a cap of 20 a day and 200 a month, and writes explicit lists, by default', () => {
    const { setup } = parseConfig('');
    expect(setup.suggested_budget).toEqual({ daily_usd: 20, monthly_usd: 200 });
    expect(setup.role_lists).toBe('explicit');
  });

  it('takes each mode and a cap of its own', () => {
    expect(parseConfig('setup:\n  role_lists: preset\n').setup.role_lists).toBe('preset');
    const { setup } = parseConfig('setup:\n  suggested_budget:\n    daily_usd: 5\n');
    expect(setup.suggested_budget).toEqual({ daily_usd: 5, monthly_usd: 200 });
  });

  it('rejects an unknown mode, a cap that is not positive and unknown keys', () => {
    expect(() => parseConfig('setup:\n  role_lists: some\n')).toThrow(InvalidInput);
    expect(() => parseConfig('setup:\n  suggested_budget:\n    daily_usd: 0\n')).toThrow(
      InvalidInput,
    );
    expect(() => parseConfig('setup:\n  extra: 1\n')).toThrow(InvalidInput);
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

  it('reads the ui.* keys of the terminal from the file and refuses a repeated shortcut (N35)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const file = join(tmp.dir, 'config.yaml');
      await writeFile(
        file,
        'ui:\n  mouse: off\n  keymap:\n    overrides:\n      tabs.add: Alt+Q\n',
      );
      const config = await loadConfig(file);
      expect(config.ui.mouse).toBe('off');
      expect(config.ui.keymap.overrides).toEqual({ 'tabs.add': 'Alt+Q' });
      await writeFile(file, 'ui:\n  keymap:\n    overrides:\n      tabs.add: Alt+S\n');
      await expect(loadConfig(file)).rejects.toThrow(/ui\.keymap\.overrides\.tabs\.add/);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('telemetry (P1 of Phase 8)', () => {
  it('has the defaults of the plan', () => {
    const config = parseConfig('');
    expect(config.telemetry).toEqual({
      enabled: 'on',
      file: 'telemetry.sqlite',
      synchronous: 'normal',
      write: { batch: 500, queue_max: 20_000, flush_interval: 1000, retry_after: 60_000 },
      clients: {
        'claude-code': { enabled: 'on', traces: 'off', metrics_interval: 5000 },
        codex: { enabled: 'on' },
        opencode: { enabled: 'on', ai_spans: 'off' },
      },
      receiver: { port: 'auto', max_body: 8 * 1024 * 1024, reparent: 'session' },
      redaction: 'default',
      daemon_spans: { enabled: 'on', waits: 'all' },
      export: 'off',
      otlp: {
        endpoint: null,
        protocol: 'http/json',
        headers: {},
        compression: 'none',
        timeout: 10_000,
        interval: 10_000,
        batch: 500,
        signals: { traces: 'on', metrics: 'on', logs: 'on' },
        retry: { retries: 3, backoff: 'exponential', initial: 1000, max: 30_000 },
        on_failure: 'drop',
        failure_report: 60_000,
      },
      prometheus: { cache_ttl: 5000 },
      retention: { mode: 'daily', interval: 86_400_000, days: 30, max_mb: 1024, guard: 'rollups' },
    });
    expect(config.log.rotate).toEqual({ mode: 'size', max_mb: 20, keep: 5 });
    expect(config.backup.telemetry).toBe('exclude');
  });

  it('takes every mode of the new keys', () => {
    const config = parseConfig(
      [
        'telemetry:',
        '  enabled: off',
        '  file: sub/t.sqlite',
        '  synchronous: full',
        '  write:',
        '    batch: 10',
        '    queue_max: 100',
        '    flush_interval: 500ms',
        '    retry_after: 5m',
        '  clients:',
        '    claude-code: off',
        '    codex:',
        '      enabled: off',
        '    opencode:',
        '      ai_spans: on',
        'backup:',
        '  telemetry: include',
        '',
      ].join('\n'),
    );
    expect(config.telemetry.enabled).toBe('off');
    expect(config.telemetry.file).toBe('sub/t.sqlite');
    expect(config.telemetry.synchronous).toBe('full');
    expect(config.telemetry.write).toEqual({
      batch: 10,
      queue_max: 100,
      flush_interval: 500,
      retry_after: 300_000,
    });
    expect(config.telemetry.clients['claude-code']).toEqual({
      enabled: 'off',
      traces: 'off',
      metrics_interval: 5000,
    });
    expect(config.telemetry.clients.codex).toEqual({ enabled: 'off' });
    expect(config.telemetry.clients.opencode).toEqual({ enabled: 'on', ai_spans: 'on' });
    expect(config.backup.telemetry).toBe('include');
    expect(
      parseConfig('telemetry:\n  clients:\n    claude-code:\n      traces: on\n').telemetry.clients[
        'claude-code'
      ],
    ).toEqual({ enabled: 'on', traces: 'on', metrics_interval: 5000 });
  });

  it('takes metrics_interval of Claude Code as a duration or client, and refuses anything else', () => {
    const clients = (yaml: string) => parseConfig(yaml).telemetry.clients['claude-code'];
    expect(
      clients('telemetry:\n  clients:\n    claude-code:\n      metrics_interval: 30s\n')
        .metrics_interval,
    ).toBe(30_000);
    expect(
      clients('telemetry:\n  clients:\n    claude-code:\n      metrics_interval: client\n')
        .metrics_interval,
    ).toBe('client');
    expect(() =>
      parseConfig('telemetry:\n  clients:\n    claude-code:\n      metrics_interval: soon\n'),
    ).toThrow();
  });

  it('takes the receiver and redaction keys of P2', () => {
    const config = parseConfig(
      'telemetry:\n  receiver:\n    port: 4318\n    max_body: 1MB\n  redaction: full\n',
    );
    expect(config.telemetry.receiver).toEqual({
      port: 4318,
      max_body: 1024 * 1024,
      reparent: 'session',
    });
    expect(config.telemetry.redaction).toBe('full');
    expect(parseConfig('telemetry:\n  receiver:\n    port: auto\n').telemetry.receiver.port).toBe(
      'auto',
    );
  });

  it('takes the modes of telemetry.receiver.reparent (Phase 9, P1) and refuses another', () => {
    expect(
      parseConfig('telemetry:\n  receiver:\n    reparent: session\n').telemetry.receiver.reparent,
    ).toBe('session');
    expect(
      parseConfig("telemetry:\n  receiver:\n    reparent: 'off'\n").telemetry.receiver.reparent,
    ).toBe('off');
    expect(() => parseConfig('telemetry:\n  receiver:\n    reparent: always\n')).toThrow(
      /reparent/,
    );
  });

  it('takes the modes of the spans of the daemon (P4)', () => {
    const spans = (yaml: string) => parseConfig(`telemetry:\n${yaml}`).telemetry.daemon_spans;
    expect(spans('  daemon_spans: off\n')).toEqual({ enabled: 'off', waits: 'all' });
    expect(spans('  daemon_spans: on\n')).toEqual({ enabled: 'on', waits: 'all' });
    expect(spans('  daemon_spans:\n    enabled: off\n    waits: off\n')).toEqual({
      enabled: 'off',
      waits: 'off',
    });
  });

  it('takes the modes of the export (P7)', () => {
    const export_ = (yaml: string) => parseConfig(`telemetry:\n${yaml}`).telemetry;
    for (const mode of ['off', 'prometheus']) {
      expect(export_(`  export: ${mode}\n`).export).toBe(mode);
    }
    const otlp = export_(
      [
        '  export: both',
        '  otlp:',
        '    endpoint: https://collector.example.org:4318',
        '    headers:',
        '      Authorization: otlp.auth',
        '    compression: gzip',
        '    timeout: 3s',
        '    interval: 500ms',
        '    batch: 50',
        '    signals:',
        '      logs: off',
        '    retry:',
        '      retries: 0',
        '      backoff: fixed',
        '      initial: 200ms',
        '      max: 2s',
        '    on_failure: hold',
        '    failure_report: 5m',
        '  prometheus:',
        '    cache_ttl: 1s',
        '',
      ].join('\n'),
    );
    expect(otlp.export).toBe('both');
    expect(otlp.otlp).toEqual({
      endpoint: 'https://collector.example.org:4318',
      protocol: 'http/json',
      headers: { Authorization: 'otlp.auth' },
      compression: 'gzip',
      timeout: 3000,
      interval: 500,
      batch: 50,
      signals: { traces: 'on', metrics: 'on', logs: 'off' },
      retry: { retries: 0, backoff: 'fixed', initial: 200, max: 2000 },
      on_failure: 'hold',
      failure_report: 300_000,
    });
    expect(otlp.prometheus.cache_ttl).toBe(1000);
    // Plain http is fine on this machine, and with no headers anywhere.
    expect(
      export_(
        '  export: otlp\n  otlp:\n    endpoint: http://127.0.0.1:4318\n    headers:\n      X-Key: k\n',
      ).otlp.endpoint,
    ).toBe('http://127.0.0.1:4318');
    expect(
      export_('  export: otlp\n  otlp:\n    endpoint: http://collector.internal:4318\n').otlp
        .endpoint,
    ).toBe('http://collector.internal:4318');
  });

  it('refuses the export that cannot work', () => {
    for (const bad of [
      'telemetry:\n  export: otlp\n',
      'telemetry:\n  export: both\n',
      'telemetry:\n  export: sometimes\n',
      'telemetry:\n  enabled: off\n  export: otlp\n  otlp:\n    endpoint: http://127.0.0.1:4318\n',
      'telemetry:\n  otlp:\n    endpoint: ftp://x\n',
      'telemetry:\n  otlp:\n    endpoint: not a url\n',
      'telemetry:\n  otlp:\n    protocol: http/protobuf\n',
      'telemetry:\n  otlp:\n    protocol: grpc\n',
      'telemetry:\n  otlp:\n    protocol: carrier-pigeon\n',
      'telemetry:\n  otlp:\n    headers:\n      "bad name": k\n',
      'telemetry:\n  otlp:\n    headers:\n      X-Key: "not a key!"\n',
      'telemetry:\n  otlp:\n    endpoint: http://collector.internal:4318\n    headers:\n      X-Key: k\n',
      'telemetry:\n  otlp:\n    compression: brotli\n',
      'telemetry:\n  otlp:\n    batch: 0\n',
      'telemetry:\n  otlp:\n    retry:\n      retries: -1\n',
      'telemetry:\n  otlp:\n    retry:\n      backoff: random\n',
      'telemetry:\n  otlp:\n    on_failure: crash\n',
      'telemetry:\n  otlp:\n    signals:\n      events: on\n',
      'telemetry:\n  prometheus:\n    cache_ttl: soon\n',
      'telemetry:\n  prometheus:\n    other: 1\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
    expect(() => parseConfig('telemetry:\n  otlp:\n    protocol: grpc\n')).toThrow(/future modes/);
    // Prometheus alone needs no telemetry base: `/metrics` answers with the telemetry off.
    expect(() => parseConfig('telemetry:\n  enabled: off\n  export: prometheus\n')).not.toThrow();
  });

  it('takes the retention of the raw telemetry and the rotation of daemon.log', () => {
    const config = parseConfig(
      [
        'telemetry:',
        '  retention:',
        '    mode: startup',
        '    interval: 6h',
        '    days: 0',
        '    max_mb: 0',
        '    guard: none',
        'log:',
        '  rotate:',
        '    mode: off',
        '    max_mb: 1',
        '    keep: 0',
        '',
      ].join('\n'),
    );
    expect(config.telemetry.retention).toEqual({
      mode: 'startup',
      interval: 6 * 3_600_000,
      days: 0,
      max_mb: 0,
      guard: 'none',
    });
    expect(config.log.rotate).toEqual({ mode: 'off', max_mb: 1, keep: 0 });
    for (const mode of ['daily', 'startup', 'off']) {
      expect(
        parseConfig(`telemetry:\n  retention:\n    mode: ${mode}\n`).telemetry.retention.mode,
      ).toBe(mode);
    }
    for (const mode of ['size', 'off']) {
      expect(parseConfig(`log:\n  rotate:\n    mode: ${mode}\n`).log.rotate.mode).toBe(mode);
    }
  });

  it('refuses bad values and unknown keys of the retention and the rotation', () => {
    for (const bad of [
      'telemetry:\n  retention:\n    mode: hourly\n',
      'telemetry:\n  retention:\n    interval: often\n',
      'telemetry:\n  retention:\n    days: -1\n',
      'telemetry:\n  retention:\n    days: 1.5\n',
      'telemetry:\n  retention:\n    max_mb: -5\n',
      'telemetry:\n  retention:\n    guard: maybe\n',
      'telemetry:\n  retention:\n    other: 1\n',
      'log:\n  rotate:\n    mode: daily\n',
      'log:\n  rotate:\n    max_mb: 0\n',
      'log:\n  rotate:\n    keep: -1\n',
      'log:\n  rotate:\n    keep: 2.5\n',
      'log:\n  rotate:\n    other: 1\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
  });

  it('refuses unknown values and keys', () => {
    for (const bad of [
      'telemetry:\n  enabled: maybe\n',
      'telemetry:\n  synchronous: off\n',
      'telemetry:\n  file: ""\n',
      'telemetry:\n  write:\n    batch: 0\n',
      'telemetry:\n  write:\n    queue_max: 1.5\n',
      'telemetry:\n  write:\n    flush_interval: soon\n',
      'telemetry:\n  clients:\n    codex: maybe\n',
      'telemetry:\n  clients:\n    codex:\n      traces: on\n',
      'telemetry:\n  clients:\n    gemini: on\n',
      'telemetry:\n  receiver:\n    port: 1\n',
      'telemetry:\n  receiver:\n    port: 70000\n',
      'telemetry:\n  receiver:\n    max_body: 0\n',
      'telemetry:\n  receiver:\n    max_body: huge\n',
      'telemetry:\n  receiver:\n    other: 1\n',
      'telemetry:\n  redaction: none\n',
      'telemetry:\n  other: 1\n',
      'telemetry:\n  daemon_spans: maybe\n',
      'telemetry:\n  daemon_spans:\n    waits: some\n',
      'telemetry:\n  daemon_spans:\n    waits: log\n',
      'telemetry:\n  daemon_spans:\n    other: on\n',
      'backup:\n  telemetry: sometimes\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
  });
});

describe('plugins.install (Phase 9, P4)', () => {
  it('defaults to every source, with a 5 minute timeout', () => {
    const config = parseConfig('');
    expect(config.plugins.install.sources).toEqual([...PLUGIN_INSTALL_SOURCES]);
    expect(config.plugins.install.timeout).toBe(5 * 60_000);
    expect(config.plugins.install.npm).toBe('auto');
  });

  it('takes the path of npm, and refuses an empty one', () => {
    expect(
      parseConfig('plugins:\n  install:\n    npm: /opt/npm/bin/npm-cli.js\n').plugins.install.npm,
    ).toBe('/opt/npm/bin/npm-cli.js');
    expect(() => parseConfig('plugins:\n  install:\n    npm: ""\n')).toThrow(InvalidInput);
  });

  it('takes a subset of sources, none included, and a duration', () => {
    expect(
      parseConfig('plugins:\n  install:\n    sources: [path]\n').plugins.install.sources,
    ).toEqual(['path']);
    expect(parseConfig('plugins:\n  install:\n    sources: []\n').plugins.install.sources).toEqual(
      [],
    );
    expect(parseConfig('plugins:\n  install:\n    timeout: 30s\n').plugins.install.timeout).toBe(
      30_000,
    );
  });

  it('refuses an unknown source, a repeated one, an unknown key and a bad duration', () => {
    for (const bad of [
      'plugins:\n  install:\n    sources: [ftp]\n',
      'plugins:\n  install:\n    sources: [path, path]\n',
      'plugins:\n  install:\n    other: 1\n',
      'plugins:\n  install:\n    timeout: soon\n',
      'plugins:\n  other: 1\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
  });
});

describe('plugins.permissions (Phase 9, P6) [proposta]', () => {
  it('takes each mode of each key', () => {
    const modes: Record<string, readonly string[]> = {
      local_write: PLUGIN_LOCAL_WRITE_MODES,
      network: PLUGIN_NETWORK_MODES,
      external_write: PLUGIN_EXTERNAL_WRITE_MODES,
      external_write_approval: PLUGIN_EXTERNAL_WRITE_APPROVAL_MODES,
      approval_detail: PLUGIN_APPROVAL_DETAIL_MODES,
    };
    for (const [key, values] of Object.entries(modes)) {
      for (const value of values) {
        const { permissions } = parseConfig(
          `plugins:\n  permissions:\n    ${key}: ${value}\n`,
        ).plugins;
        expect(permissions[key as keyof typeof permissions], `${key}: ${value}`).toBe(value);
      }
    }
  });

  it('refuses a value that is no mode, a key that does not exist and a section that is no object', () => {
    for (const bad of [
      'plugins:\n  permissions:\n    local_write: always\n',
      'plugins:\n  permissions:\n    network: true\n',
      'plugins:\n  permissions:\n    external_write_approval: never\n',
      'plugins:\n  permissions:\n    approval_detail: all\n',
      'plugins:\n  permissions:\n    critic: allow\n',
      'plugins:\n  permissions: deny\n',
    ]) {
      expect(() => parseConfig(bad), bad).toThrow(InvalidInput);
    }
  });
});
