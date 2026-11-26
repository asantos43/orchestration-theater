// SPDX-License-Identifier: MPL-2.0
import type { i18n as I18nInstance } from 'i18next';
import { cleanup, render } from 'ink-testing-library';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain, waitFor } from '../ink.test-support.js';
import { buildTuiKeymap } from '../keys/use-keymap.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type {
  SetupDetectedClient,
  SetupExecutor,
  SetupModel,
  SetupModels,
  SetupNote,
} from '@otheater/protocol';
import type { SetupExecutorsInputMode, SetupModelPickMode } from '../settings.js';
import type { SetupFlow } from './api.js';
import {
  FakeSetupApi,
  FakeSetupAccounts,
  type FakeSetupOptions,
  profileOf,
  requestError,
} from './fake-api.test-support.js';
import { SetupScreen, type SetupOutcome } from './setup-screen.js';

/**
 * The setup screen over `ink-testing-library` and a fake daemon (P17 of Phase 7): fake accounts, no
 * login, no real daemon. The screen draws what the daemon says; these tests say which command went
 * for each key and what the person saw of the answer.
 */

let i18n: I18nInstance;
beforeAll(async () => {
  i18n = await createTuiI18n('en', loadTuiCatalogs());
});
afterEach(cleanup);

const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const SHIFT_DOWN = '\x1b[1;2B';
const TAB = '\t';

const keymap = buildTuiKeymap(
  { preset: 'agents', environment: 'auto', overrides: {} },
  { env: {}, platform: 'linux' },
);

/** Both clients on the machine (a test that adds an account of each). */
const BOTH_INSTALLED: readonly SetupDetectedClient[] = [
  { client: 'claude-code', installed: true },
  { client: 'codex', installed: true },
];

/** The three clients on the machine (OpenCode asks for its provider). */
const ALL_INSTALLED: readonly SetupDetectedClient[] = [
  ...BOTH_INSTALLED,
  { client: 'opencode', installed: true },
];

const PROFILES = [
  profileOf('claude-code/main'),
  profileOf('codex/work'),
  profileOf('claude-code/old', { usable: false, login: 'logged_out' }),
];

interface Mounted {
  readonly api: FakeSetupApi;
  readonly outcomes: SetupOutcome[];
  frame(): string;
  press(keys: string): Promise<string>;
  type(text: string): Promise<void>;
  seen(text: string | RegExp): Promise<string>;
}

function mount(
  flow: SetupFlow,
  api: FakeSetupApi = new FakeSetupApi({ profiles: PROFILES }),
  modelPick?: SetupModelPickMode,
  executorsInput?: SetupExecutorsInputMode,
): Mounted {
  const outcomes: SetupOutcome[] = [];
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SetupScreen
        flow={flow}
        api={api}
        keymap={keymap}
        modelPick={modelPick}
        executorsInput={executorsInput}
        onClose={(o) => outcomes.push(o)}
      />
    </I18nextProvider>,
  );
  Object.defineProperty(view.stdout, 'columns', { value: 110, configurable: true });
  Object.defineProperty(view.stdout, 'rows', { value: 40, configurable: true });
  view.stdout.emit('resize');
  const frame = (): string => plain(view.lastFrame() ?? '');
  const settle = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const mounted: Mounted = {
    api,
    outcomes,
    frame,
    press: async (keys) => {
      view.stdin.write(keys);
      await settle();
      return frame();
    },
    type: async (text) => {
      for (const char of text) {
        view.stdin.write(char);
        await settle(3);
      }
      await settle();
    },
    seen: async (text) => {
      const found = await waitFor(
        () => {
          const current = frame();
          return (typeof text === 'string' ? current.includes(text) : text.test(current))
            ? current
            : undefined;
        },
        `${String(text)} (last frame: ${frame()})`,
      );
      await settle();
      return found;
    },
  };
  return mounted;
}

describe('the setup screen: first run', () => {
  it('goes from the first step to the confirmation with the keys alone', async () => {
    const screen = mount('first_run');
    const detect = await screen.seen('Pick the accounts that take part');
    expect(detect).toContain('Setup assistant: first run');
    expect(detect).toContain('Step 1 of 4');
    expect(detect).toContain('[x] 1. claude-code/main');
    expect(detect).toContain('[x] 2. codex/work');
    // The account that is not usable starts out of the run.
    expect(detect).toContain('[ ]    claude-code/old');
    expect(detect).toContain('Clients on this machine: claude-code (installed), codex (not found)');

    await screen.press(ENTER);
    const preset = await screen.seen('Pick the preset of the roles.');
    expect(preset).toContain('balanced: quality where it counts');
    // The cursor starts on the middle preset when the configuration names none.
    expect(preset).toMatch(/›balanced/);
    await screen.press(DOWN);
    await screen.press(ENTER);

    const executors = await screen.seen('Register Executors by API or local model');
    expect(executors).toContain('None. Enter continues without one.');
    await screen.press('a');
    await screen.type('codex/work gpt-5 high');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('codex/work  gpt-5  effort high');
    await screen.press(ENTER);

    const review = await screen.seen('This is what will be written.');
    expect(review).toContain('Preset: economical');
    expect(review).toMatch(/codex\/work +1 new Executor/);
    expect(review).toMatch(/claude-code\/old +out: logged out/);
    expect(review).toContain('2 keys written · D shows the details');
    expect(review).not.toContain('roles.preset');
    expect(await screen.press('d')).toContain('roles.preset');
    await screen.press(ENTER);

    // The finished screen repeats the summary of the review (2026-11-26).
    const done = await screen.seen('✓ Done. The configuration was written.');
    expect(done).toContain('Preset: economical');
    expect(done).toMatch(/codex\/work +1 new Executor/);
    expect(done).toContain('✓ 2 keys written');
    expect(done).toContain('Next step: close the assistant');
    expect(screen.outcomes).toEqual([]);
    await screen.press(ENTER);
    expect(screen.outcomes).toEqual(['confirmed']);

    expect(screen.api.calls).toEqual([
      'overview',
      'start:first_run',
      'submit:detect',
      'submit:preset',
      'submit:executors',
      'confirm',
    ]);
    expect(screen.api.submissions[0]).toEqual({
      step: 'detect',
      input: { accounts: ['claude-code/main', 'codex/work'] },
    });
    expect(screen.api.submissions[1]).toEqual({ step: 'preset', input: { preset: 'economical' } });
    expect(screen.api.submissions[2]).toEqual({
      step: 'executors',
      input: {
        executors: [{ profileId: 'codex/work', model: 'gpt-5', effort: 'high' }],
        budgets: [],
      },
    });
    expect(screen.api.written).toHaveLength(1);
  });

  it('takes an account out, puts it back and reorders it before sending the detection', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    // Take the first one out, put the third in (it is not usable, but the daemon decides) and reorder.
    await screen.press(' ');
    expect(screen.frame()).toContain('[ ]    claude-code/main');
    await screen.press(DOWN);
    await screen.press(SHIFT_DOWN);
    await screen.press(UP);
    await screen.press(' ');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
    expect(screen.api.submissions[0]).toEqual({
      step: 'detect',
      input: { accounts: ['claude-code/old', 'codex/work'] },
    });
  });

  it('goes back one step and brings back what was chosen there', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    await screen.press(' ');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
    expect(screen.frame()).toContain('● Preset');
    await screen.press(ESC);
    const back = await screen.seen('Pick the accounts that take part');
    expect(back).toContain('● Accounts');
    // The draft of the step is the one the person left, not a new one.
    expect(back).toContain('[ ]    claude-code/main');
    expect(screen.api.calls).toContain('back');
    expect(screen.outcomes).toEqual([]);
  });

  it('leaves at the first step with Esc, keeps the run, and a new screen resumes the same step', async () => {
    const first = mount('first_run');
    await first.seen('Pick the accounts');
    await first.press(ENTER);
    await first.seen('Pick the preset of the roles.');
    await first.press(DOWN);
    await first.press(ENTER);
    await first.seen('Register Executors');
    const api = first.api;
    cleanup();

    // The TUI was closed midway; it opens again over the same daemon.
    const second = mount('first_run', api);
    const resumed = await second.seen('Register Executors by API');
    expect(resumed).toContain('Resuming the run you left midway, at the step Executors.');
    expect(resumed).toContain('Step 3 of 4');
    expect(api.calls.filter((call) => call.startsWith('start'))).toEqual(['start:first_run']);
    // Back reaches the step that was answered, with the daemon's answer in place.
    await second.press(ESC);
    await second.seen('Pick the preset of the roles.');
    await second.press(ESC);
    await second.seen('Pick the accounts that take part');
    expect(second.frame()).toContain('leaves; the run stays saved');
    await second.press(ESC);
    await waitFor(
      () => (second.outcomes.length > 0 ? true : undefined),
      'the setup screen to leave',
    );
    expect(second.outcomes).toEqual(['left']);
    expect(api.active.has('first_run')).toBe(true);
    expect(api.calls.filter((call) => call === 'cancel')).toEqual([]);
  });

  it('shows what the daemon refused as the daemon said it, and stays at the step', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
    await screen.press(ENTER);
    await screen.seen('Register Executors');
    await screen.press('a');
    await screen.type('codex/work bad-model');
    await screen.press(ENTER);
    await screen.press(ENTER);
    const refused = await screen.seen('Refused by the daemon');
    expect(refused).toContain('The model bad-model is not in the catalog.');
    expect(refused).toContain('● Executors');
    // The draft is kept so the person can fix it: the row is still there.
    expect(refused).toContain('codex/work  bad-model');
    await screen.press('x');
    expect(screen.frame()).toContain('None. Enter continues without one.');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
  });

  it('shows the failure of a command that is not a conflict and lets the person try again', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    screen.api.failNext = requestError('unavailable', 503, 'The daemon is busy.');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('Refused by the daemon: The daemon is busy.');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
  });

  it('reads the run again when the daemon says the run moved (a conflict)', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    // Another client answered the first step: the daemon is already at the preset.
    const other = screen.api;
    const run = other.active.get('first_run');
    if (run === undefined) throw new Error('no run');
    await other.submit(run.run.id, { step: 'detect', input: {} });
    await screen.press(ENTER);
    const reread = await screen.seen('Pick the preset of the roles.');
    expect(reread).toContain('Refused by the daemon');
    expect(reread).toContain('● Preset');
  });

  it('cancels the run only after y, and writes nothing', async () => {
    const screen = mount('first_run');
    await screen.seen('Pick the accounts');
    await screen.press('c');
    expect(screen.frame()).toContain('Cancel this run? Nothing was written. y/n');
    await screen.press('n');
    expect(screen.frame()).not.toContain('Cancel this run?');
    expect(screen.api.calls).not.toContain('cancel');
    await screen.press('c');
    await screen.press('y');
    const cancelled = await screen.seen('Run cancelled. Nothing was written.');
    expect(cancelled).toContain('closes the assistant');
    expect(screen.api.written).toEqual([]);
    expect(screen.api.active.size).toBe(0);
    await screen.press(ENTER);
    expect(screen.outcomes).toEqual(['cancelled']);
  });

  it('says why the assistant did not open and tries again with R', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    api.failNext = requestError('unavailable', 503, 'The daemon is starting.');
    const screen = mount('first_run', api);
    const failed = await screen.seen('Could not open the assistant: The daemon is starting.');
    expect(failed).toContain('tries again');
    await screen.press('r');
    await screen.seen('Pick the accounts that take part');
    expect(screen.outcomes).toEqual([]);
  });

  it('leaves from the failure screen with Esc', async () => {
    const api = new FakeSetupApi();
    api.failNext = requestError('unavailable', 503, 'The daemon is starting.');
    const screen = mount('first_run', api);
    await screen.seen('Could not open the assistant');
    await screen.press(ESC);
    await waitFor(
      () => (screen.outcomes.length > 0 ? true : undefined),
      'the setup screen to leave',
    );
    expect(screen.outcomes).toEqual(['left']);
  });

  it('says that there is no account when the daemon has none', async () => {
    const screen = mount('first_run', new FakeSetupApi());
    const frame = await screen.seen('No account yet.');
    expect(frame).toContain('Add one in the Settings tab');
  });
});

describe('the setup screen: executors and caps', () => {
  const API_PROFILE = profileOf('openrouter/key', { kind: 'api', hasSecret: true });

  async function atExecutors(): Promise<Mounted> {
    const screen = mount('add_account', new FakeSetupApi({ profiles: [API_PROFILE] }));
    await screen.seen('Pick the account to bring into the roles.');
    await screen.press(ENTER);
    await screen.seen('Spending caps of the API accounts');
    return screen;
  }

  it('lists the suggested cap of an API account and takes the one the person types', async () => {
    const screen = await atExecutors();
    expect(screen.frame()).toContain('openrouter/key  suggested: day USD 5, month USD 50');
    // The cursor walks from the registered rows to the caps; with no row it is on the first cap.
    await screen.press('e');
    expect(screen.frame()).toContain('Cap of openrouter/key as: <day> <month>');
    await screen.type('2,5 -');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('openrouter/key  day USD 2.5  month no cap');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    expect(screen.api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: {
        executors: [],
        budgets: [{ profileId: 'openrouter/key', dailyUsd: 2.5, monthlyUsd: null }],
      },
    });
  });

  it('refuses a cap that is not two numbers and keeps the screen', async () => {
    const screen = await atExecutors();
    await screen.press('e');
    await screen.type('0 5');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('Write <day> <month>: numbers above zero, or - for no cap.');
    expect(screen.api.calls).not.toContain('submit:executors');
  });

  it('refuses an Executor line with one word and cancels a prompt with Esc', async () => {
    const screen = await atExecutors();
    await screen.press('a');
    await screen.type('only-one');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('Write <account> <model> [effort].');
    await screen.press('a');
    await screen.type('x y');
    await screen.press(ESC);
    // Esc is a lone escape byte, so Ink may only settle it after a short wait.
    const closed = await screen.seen(/^(?![\s\S]*Executor as:)/);
    expect(closed).toContain('None. Enter continues without one.');
  });

  it('moves the cursor with the arrows over the rows and the caps', async () => {
    const screen = await atExecutors();
    await screen.press('a');
    await screen.type('openrouter/key some-model');
    await screen.press(ENTER);
    expect(screen.frame()).toMatch(/›openrouter\/key {2}some-model/);
    await screen.press(DOWN);
    expect(screen.frame()).toMatch(/›openrouter\/key {2}suggested/);
    await screen.press(UP);
    expect(screen.frame()).toMatch(/›openrouter\/key {2}some-model/);
  });
});

describe('the setup screen: the other flows', () => {
  it('add account: the account, the Executors and the review, in that order', async () => {
    const screen = mount('add_account');
    const first = await screen.seen('Pick the account to bring into the roles.');
    expect(first).toContain('Setup assistant: add an account');
    expect(first).toContain('Step 1 of 3');
    await screen.press(DOWN);
    await screen.press(ENTER);
    await screen.seen('Register Executors');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    await screen.press(ENTER);
    await screen.seen('Done. The configuration was written.');
    expect(screen.api.submissions[0]).toEqual({
      step: 'account',
      input: { profileId: 'codex/work' },
    });
    expect(screen.api.calls).toContain('start:add_account');
    expect(screen.api.calls).not.toContain('start:first_run');
  });

  it('change preset: starts on the one in force and goes to the review', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, current: 'quality' });
    const screen = mount('change_preset', api);
    const preset = await screen.seen('Pick the preset of the roles.');
    expect(preset).toContain('Setup assistant: change the preset');
    expect(preset).toContain('Step 1 of 2');
    expect(preset).toMatch(/›quality: the best Executor first {2}\(in use\)/);
    await screen.press(DOWN);
    await screen.press(DOWN);
    await screen.press(ENTER);
    const review = await screen.seen('This is what will be written.');
    expect(review).toContain('Preset: economical');
    await screen.press(ENTER);
    await screen.seen('Done.');
    expect(api.written[0]?.preset).toBe('economical');
  });

  it('folds the notes of the review by family, and D shows each one (N324)', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, current: 'quality' });
    const noAccount = (head: string, role: 'author' | 'reviewer'): SetupNote => ({
      severity: 'info',
      code: 'no_account',
      role,
      head,
      message: `no account has ${head} for ${role}`,
    });
    api.notes = [
      noAccount('claude-opus-high', 'author'),
      noAccount('claude-opus-high', 'reviewer'),
      noAccount('claude-sonnet-medium', 'author'),
      noAccount('codex-sol-high', 'author'),
      { severity: 'warning', code: 'empty_list', role: 'author', message: 'author is empty' },
      { severity: 'info', code: 'other', role: null, message: 'a note of its own' },
    ];
    const screen = mount('change_preset', api);
    await screen.seen('Pick the preset of the roles.');
    await screen.press(ENTER);
    const folded = await screen.seen('This is what will be written.');
    expect(folded).toContain(
      '· 2 models of the preset with no account (claude): claude-opus-high, claude-sonnet-medium',
    );
    expect(folded).toContain('· 1 model of the preset with no account (codex): codex-sol-high');
    expect(folded).toContain('⚠ no Executor in author: they follow the when-exhausted rule');
    // A code the locale does not word shows the daemon's message.
    expect(folded).toContain('· a note of its own');
    expect(folded).not.toContain('no account has claude-opus-high for reviewer');
    expect(folded).toContain('D shows the details');
    const all = await screen.press('d');
    expect(all).toContain('claude-opus-high has no account: left out of reviewer');
    expect(all).toContain('no account has claude-opus-high for reviewer');
    expect(all).toContain('author is empty');
    expect(all).toContain('D folds the notes and the keys again');
    expect(await screen.press('d')).not.toContain('no account has claude-opus-high for reviewer');
  });

  it('shows every note at once with ui.setup.reviewNotes all (N324)', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, current: 'quality' });
    api.notes = [
      {
        severity: 'info',
        code: 'no_account',
        role: 'author',
        head: 'codex-sol-high',
        message: 'one by one',
      },
    ];
    const outcomes: SetupOutcome[] = [];
    const view = render(
      <I18nextProvider i18n={i18n}>
        <SetupScreen
          flow="change_preset"
          api={api}
          keymap={keymap}
          reviewNotes="all"
          onClose={(o) => outcomes.push(o)}
        />
      </I18nextProvider>,
    );
    const frame = (): string => plain(view.lastFrame() ?? '');
    await waitFor(() => (frame().includes('Pick the preset') ? true : undefined), 'preset');
    view.stdin.write(ENTER);
    const review = await waitFor(
      () => (frame().includes('This is what will be written.') ? frame() : undefined),
      'review',
    );
    expect(review).toContain('codex-sol-high has no account: left out of author');
    expect(review).toContain('one by one');
    expect(review).not.toContain('models of the preset with no account');
  });

  it('shows the preset as kept when the plan does not change it', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    const screen = mount('add_account', api);
    await screen.seen('Pick the account');
    await screen.press(ENTER);
    await screen.seen('Register Executors');
    await screen.press(ENTER);
    const review = await screen.seen('This is what will be written.');
    expect(review).toContain('Preset: kept as it is');
  });

  it('takes a second start of the flow as the run already in progress', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    // The overview says there is no run, but another client starts one before this screen does.
    const real = api.overview.bind(api);
    let first = true;
    api.overview = async () => {
      const overview = await real();
      if (!first) return overview;
      first = false;
      await api.start('change_preset');
      return { ...overview, flows: overview.flows.map((flow) => ({ ...flow, active: null })) };
    };
    const screen = mount('change_preset', api);
    await screen.seen('Pick the preset of the roles.');
    expect(api.calls.filter((call) => call === 'start:change_preset')).toHaveLength(2);
    expect(screen.frame()).not.toContain('Could not open');
  });
});

describe('the setup screen: the step that adds an account (N274)', () => {
  function withAccounts(options: Partial<FakeSetupOptions> = {}): {
    api: FakeSetupApi;
    accounts: FakeSetupAccounts;
  } {
    const api = new FakeSetupApi({ profiles: PROFILES, withAccounts: true, ...options });
    const accounts = api.accounts;
    if (accounts === undefined) throw new Error('the fake has no accounts');
    return { api, accounts };
  }

  async function atStep(api: FakeSetupApi, modelPick?: SetupModelPickMode): Promise<Mounted> {
    const screen = mount('first_run', api, modelPick);
    await screen.seen('Add an account of a client');
    return screen;
  }

  it('comes before the detection, lists the clients and can be skipped', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    const frame = screen.frame();
    expect(frame).toContain('Step 1 of 5');
    expect(frame).toContain('● New account  ○ Accounts  ○ Preset  ○ Executors  ○ Review');
    expect(frame).toContain('›claude-code  (installed)');
    expect(frame).toContain('codex  (not found)');
    expect(frame).toContain('adds another account');
    // The run of the daemon starts at the detection: the step is the screen's, not a step of it.
    expect(frame).toContain('Esc leaves');
    const detect = await screen.press(ENTER);
    expect(detect).toContain('Step 2 of 5');
    expect(detect).toContain('Pick the accounts that take part');
    expect(detect).toContain('✓ New account  ● Accounts');
    expect(accounts.added).toEqual([]);
    expect(api.calls).not.toContain('submit:detect');
  });

  it('adds the account of the client under the cursor and logs in to it at once', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    await screen.press('a');
    // The form (N326): one client ready, so it is chosen already and the cursor is on the name.
    const form = screen.frame();
    expect(form).toContain('Client: claude-code');
    expect(form).toContain('›Name: main▏');
    expect(form).toContain('Provider: anthropic (the only one of this client)');
    expect(form).toContain('Enter adds and opens the sign-in');
    // The default name goes away at the first key.
    await screen.type('work');
    await screen.press(ENTER);
    const done = await screen.seen('Added in this run: claude-code/work');
    expect(accounts.added).toEqual([
      { client: 'claude-code', name: 'work', kind: 'token_plan', provider: 'anthropic' },
    ]);
    // Nothing real runs: the terminal command goes to the fake.
    expect(accounts.logins).toEqual(['start:claude-code/work']);
    expect(accounts.ran).toEqual(['ot profile exec claude-code/work login']);
    expect(done).toContain('The sign-in ended with code 0.');
    expect(done).not.toContain('Name: ');
    // The detection lists the account just added.
    const detect = await screen.press(ENTER);
    expect(detect).toContain('claude-code/work');
  });

  it('keeps the default name main when nothing is typed', async () => {
    const { api, accounts } = withAccounts({ profiles: [] });
    const screen = await atStep(api);
    await screen.press('a');
    await screen.press(ENTER);
    await screen.seen('Added in this run: claude-code/main');
    expect(accounts.added[0]).toMatchObject({ client: 'claude-code', name: 'main' });
  });

  it('only OpenCode asks for the provider; the others take their own', async () => {
    const { api, accounts } = withAccounts({ clients: ALL_INSTALLED });
    const screen = await atStep(api);
    await screen.press(DOWN);
    await screen.press('a');
    // Several clients ready: the cursor starts on the client, the one under the cursor chosen.
    const codex = screen.frame();
    expect(codex).toContain('›Client:  claude-code  [codex]  opencode');
    expect(codex).toContain('Provider: openai (the only one of this client)');
    // Space moves to the next client: OpenCode, which shows the field of the provider.
    const opencode = await screen.press(' ');
    expect(opencode).toContain('[opencode]');
    expect(opencode).not.toContain('the only one of this client');
    await screen.press(TAB);
    await screen.type('alt');
    await screen.press(TAB);
    await screen.press(TAB);
    await screen.type('openrouter');
    await screen.press(ENTER);
    await screen.seen('Added in this run: opencode/alt');
    expect(accounts.added[0]).toEqual({
      client: 'opencode',
      name: 'alt',
      kind: 'token_plan',
      provider: 'openrouter',
    });
  });

  it('OpenCode without a provider adds nothing and says what is missing', async () => {
    const { api, accounts } = withAccounts({ clients: ALL_INSTALLED });
    const screen = await atStep(api);
    await screen.press(DOWN);
    await screen.press(DOWN);
    await screen.press('a');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('Write the provider, such as openai or anthropic.');
    expect(accounts.added).toEqual([]);
  });

  it('a wrong name adds nothing and says why', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('Work');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('The name takes lowercase letters');
    expect(accounts.added).toEqual([]);
    expect(accounts.logins).toEqual([]);
  });

  it('adds an API account with its key, hidden, and does not log in', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('paid');
    await screen.press(TAB);
    const kind = await screen.press(' ');
    expect(kind).toContain('[API]');
    expect(kind).toContain('API key: ');
    await screen.press(TAB);
    await screen.type('sk-fake');
    expect(screen.frame()).toContain('API key: •••••••▏');
    expect(screen.frame()).not.toContain('sk-fake');
    await screen.press(ENTER);
    const done = await screen.seen('Account added: claude-code/paid.');
    expect(done).not.toContain('sk-fake');
    expect(accounts.added[0]).toMatchObject({ kind: 'api', apiKey: 'sk-fake' });
    expect(accounts.logins).toEqual([]);
  });

  it('Esc drops the form and stays at the step', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    const back = await screen.press(ESC);
    expect(back).not.toContain('Name: ');
    expect(back).toContain('Add an account of a client');
    expect(screen.outcomes).toEqual([]);
    expect(accounts.added).toEqual([]);
  });

  it('with no account yet, Enter opens the form and S skips with a notice (N326)', async () => {
    const { api, accounts } = withAccounts({ profiles: [] });
    const screen = await atStep(api);
    expect(screen.frame()).toContain('No account yet: Enter opens the form');
    expect(screen.frame()).toContain('S  No account');
    expect(screen.frame()).toContain('Enter  Add account');
    const form = await screen.press(ENTER);
    expect(form).toContain('Name: main');
    // The bar shows the keys of the form, not the ones of the step.
    expect(form).toContain('Enter  Add   Tab  Next field   Space  Change   Esc  Cancel');
    expect(form).not.toContain('S  No account');
    await screen.press(ESC);
    const skipped = await screen.press('s');
    expect(skipped).toContain('Continuing without an account');
    expect(skipped).toContain('Step 2 of 5');
    expect(accounts.added).toEqual([]);
  });

  it('with no client ready, Enter says what to do and opens no form', async () => {
    const { api } = withAccounts({
      profiles: [],
      clients: [{ client: 'claude-code', installed: false, reason: 'adapter_missing' }],
    });
    const screen = await atStep(api);
    const frame = (await screen.press(ENTER)).replace(/[│\n]/g, ' ').replace(/\s+/g, ' ');
    expect(frame).toContain('No client is ready on this machine yet.');
    expect(frame).not.toContain('Name: ');
  });

  it('a login the daemon would run itself is cancelled and run in the terminal [proposta]', async () => {
    const { api, accounts } = withAccounts();
    accounts.loginAnswer = 'started';
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    await screen.seen('The sign-in ended with code 0.');
    expect(accounts.logins).toEqual(['start:claude-code/work', 'cancel:claude-code/work']);
    expect(accounts.ran).toEqual(['ot profile exec claude-code/work login']);
  });

  it('does not log in to an account that already has a login', async () => {
    const { api, accounts } = withAccounts();
    accounts.newLogin = 'logged_in';
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    const frame = await screen.seen('It already has a login.');
    expect(frame).toContain('Added in this run: claude-code/work');
    expect(accounts.logins).toEqual([]);
    expect(accounts.ran).toEqual([]);
  });

  it('says how to log in later when the terminal cannot run the login, and keeps the account', async () => {
    const { api, accounts } = withAccounts();
    accounts.failRun = new Error('no such program');
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    const frame = (await screen.seen('The sign-in could not run: no such program.'))
      .replace(/[│\n]/g, ' ')
      .replace(/\s+/g, ' ');
    // The texts of the assistant name no command (N321): the tab Settings signs in later.
    expect(frame).toContain('You can sign in later in the Settings tab.');
    expect(frame).not.toContain('ot profile');
    expect(frame).toContain('Added in this run: claude-code/work');
  });

  it('shows what the daemon refuses and stays at the step', async () => {
    const { api, accounts } = withAccounts();
    accounts.failAdd = requestError('conflict', 409, 'Profile claude-code/work already exists.');
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    const frame = await screen.seen('The account was not added:');
    expect(frame).toContain('Profile claude-code/work already exists.');
    expect(frame).toContain('Add an account of a client');
    expect(accounts.logins).toEqual([]);
  });

  it('says in its own words that the daemon does not run the client (N326)', async () => {
    const { api, accounts } = withAccounts();
    accounts.failAdd = requestError('invalid_input', 400, 'Unknown client "claude-code"', {
      reason: 'unknown_client',
      client: 'claude-code',
      known: ['codex', 'opencode'],
    });
    const screen = await atStep(api);
    await screen.press('a');
    await screen.press(ENTER);
    const frame = (await screen.seen('is not a client the daemon runs'))
      .replace(/[│\n]/g, ' ')
      .replace(/\s+/g, ' ');
    expect(frame).toContain('the clients are codex, opencode');
  });

  it('asks before a second subscription of the same provider, and adds it with the notice accepted', async () => {
    const { api, accounts } = withAccounts();
    accounts.noticeFirst = true;
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    expect(await screen.seen('anthropic already has claude-code/main. Add another? y/n')).toContain(
      'y confirms',
    );
    expect(accounts.added).toEqual([]);
    await screen.press('y');
    await screen.seen('Added in this run: claude-code/work');
    expect(accounts.added[0]).toMatchObject({ name: 'work', acceptNotice: true });
  });

  it('any other key answers no to that notice', async () => {
    const { api, accounts } = withAccounts();
    accounts.noticeFirst = true;
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    await screen.seen('Add another? y/n');
    await screen.press('n');
    expect(accounts.added).toEqual([]);
    expect(screen.frame()).not.toContain('Add another?');
  });

  it('back from the detection returns to the step, and Esc there leaves the run saved', async () => {
    const { api } = withAccounts();
    const screen = await atStep(api);
    await screen.press(ENTER);
    await screen.seen('Pick the accounts that take part');
    expect(screen.frame()).not.toContain('Esc leaves');
    await screen.press(ESC);
    await screen.seen('Add an account of a client');
    expect(screen.outcomes).toEqual([]);
    await screen.press(ESC);
    expect(screen.outcomes).toEqual(['left']);
    expect(api.active.has('first_run')).toBe(true);
    expect(api.calls).not.toContain('back');
  });

  it('can be repeated: a second account of another client', async () => {
    const { api, accounts } = withAccounts({ clients: BOTH_INSTALLED });
    const screen = await atStep(api);
    await screen.press('a');
    await screen.press(TAB);
    await screen.type('work');
    await screen.press(ENTER);
    await screen.seen('Added in this run: claude-code/work');
    await screen.press(DOWN);
    await screen.press('a');
    await screen.press(TAB);
    await screen.type('home');
    await screen.press(ENTER);
    await screen.seen('Added in this run: claude-code/work, codex/home');
    expect(accounts.added.map((body) => `${body.client}/${body.name}`)).toEqual([
      'claude-code/work',
      'codex/home',
    ]);
    // Both come in at the detection, checked (the owner on 2026-11-26: "Reler e marcar").
    const detect = await screen.press(ENTER);
    expect(detect).toMatch(/\[x\] \d\. claude-code\/work/);
    expect(detect).toMatch(/\[x\] \d\. codex\/home/);
  });

  it('reads the accounts again on its way out, after a read that failed', async () => {
    const { api } = withAccounts({ clients: BOTH_INSTALLED });
    const screen = await atStep(api);
    const real = api.overview.bind(api);
    let failing = true;
    api.overview = async () => {
      if (failing) throw new Error('timed out');
      return real();
    };
    await screen.press(DOWN);
    await screen.press('a');
    await screen.press(TAB);
    await screen.type('home');
    await screen.press(ENTER);
    // The account was added; the read after it failed, and the screen says so, with R.
    await screen.seen('Added in this run: codex/home');
    await screen.seen('could not be read again');
    failing = false;
    const detect = await screen.press(ENTER);
    expect(detect).toContain('Pick the accounts that take part');
    expect(detect).toMatch(/\[x\] \d\. codex\/home/);
  });

  it('goes on when the read on its way out fails, and says so', async () => {
    const { api } = withAccounts();
    const screen = await atStep(api);
    api.overview = () => Promise.reject(new Error('timed out'));
    const detect = await screen.press(ENTER);
    expect(detect).toContain('Pick the accounts that take part');
    expect(detect).toContain('could not be read again');
  });

  it('keeps the marks of the detection when it comes back for another account', async () => {
    const { api } = withAccounts({ clients: BOTH_INSTALLED });
    const screen = await atStep(api);
    await screen.press(ENTER);
    await screen.seen('Pick the accounts that take part');
    // The first account (claude-code/main) goes out.
    const unchecked = await screen.press(' ');
    expect(unchecked).toMatch(/\[ \] +claude-code\/main/);
    await screen.press(ESC);
    await screen.seen('Add an account of a client');
    await screen.press(DOWN);
    await screen.press('a');
    await screen.press(TAB);
    await screen.type('home');
    await screen.press(ENTER);
    await screen.seen('Added in this run: codex/home');
    const detect = await screen.press(ENTER);
    expect(detect).toMatch(/\[ \] +claude-code\/main/);
    expect(detect).toMatch(/\[x\] \d\. codex\/home/);
  });

  it('is only in the first run, not in the other flows', async () => {
    const { api } = withAccounts();
    const screen = mount('add_account', api);
    const first = await screen.seen('Pick the account to bring into the roles.');
    expect(first).toContain('Step 1 of 3');
    expect(first).not.toContain('New account');
  });
});

describe('the setup screen: the list of models after a login (N324, item 2)', () => {
  const WORK = 'claude-code/work';
  const OPUS = `claude-opus@${WORK}`;
  const SONNET = `claude-sonnet@${WORK}`;

  function model(id: string, extra: Partial<SetupModel> = {}): SetupModel {
    return {
      id,
      name: null,
      family: null,
      efforts: [],
      local: false,
      contextWindow: null,
      floating: null,
      preset: [],
      registered: [],
      ...extra,
    };
  }

  function listed(login: SetupModels['login'] = 'logged_in'): SetupModels {
    return {
      profileId: WORK,
      kind: 'token_plan',
      login,
      preset: 'balanced',
      catalog: 'listed',
      reason: null,
      models: [
        model('claude-opus-4-1', { name: 'Opus 4.1', preset: [{ id: OPUS, effort: null }] }),
        model('claude-sonnet-4-5', { preset: [{ id: SONNET, effort: null }] }),
        model('claude-haiku-4-5'),
        model('claude-old', { registered: ['claude-old@claude-code/work'] }),
      ],
      notes: [],
    };
  }

  function discovered(id: string, modelId: string): SetupExecutor {
    return {
      id,
      profileId: WORK,
      model: modelId,
      alias: modelId,
      effort: null,
      provider: 'anthropic',
      source: 'discovered',
      presetExpand: true,
      local: null,
    };
  }

  function withModels(answer: (call: number) => SetupModels): {
    api: FakeSetupApi;
    accounts: FakeSetupAccounts;
  } {
    const api = new FakeSetupApi({ profiles: PROFILES, withAccounts: true });
    const accounts = api.accounts;
    if (accounts === undefined) throw new Error('the fake has no accounts');
    let call = 0;
    // Only the new account has a client that lists models; the other accounts have none.
    accounts.modelsOf = (profileId) =>
      profileId === WORK
        ? answer(call++)
        : { ...answer(0), profileId, catalog: 'none', models: [] };
    api.discovered = [discovered(OPUS, 'claude-opus-4-1'), discovered(SONNET, 'claude-sonnet-4-5')];
    return { api, accounts };
  }

  async function addWork(api: FakeSetupApi, modelPick?: SetupModelPickMode): Promise<Mounted> {
    const screen = mount('first_run', api, modelPick);
    await screen.seen('Add an account of a client');
    await screen.press('a');
    await screen.type('work');
    await screen.press(ENTER);
    return screen;
  }

  it('opens after the login with the preset checked, and the step of the Executors starts with the choice', async () => {
    const { api, accounts } = withModels(() => listed());
    const screen = await addWork(api);
    const list = await screen.seen('Models of claude-code/work');
    expect(list).toContain('[x] claude-opus-4-1 (Opus 4.1)  in the preset');
    expect(list).toContain('[x] claude-sonnet-4-5  in the preset');
    expect(list).toContain('[ ] claude-haiku-4-5');
    expect(list).toContain('[=] claude-old  already an Executor');
    expect(list).toContain('Enter  Take   Space  Check   Esc  Keep the preset');
    expect(accounts.logins).toEqual([`start:${WORK}`, `models:${WORK}`]);
    // Space on Opus unchecks it; Haiku, two rows down, is checked.
    await screen.press(' ');
    await screen.press(DOWN);
    await screen.press(DOWN);
    await screen.press(' ');
    // A registered model takes no mark.
    await screen.press(DOWN);
    const marked = await screen.press(' ');
    expect(marked).toContain('[ ] claude-opus-4-1');
    expect(marked).toContain('[x] claude-haiku-4-5');
    expect(marked).toContain('[=] claude-old');
    await screen.press(ENTER);
    await screen.seen('claude-code/work: 2 models checked');

    await screen.press(ENTER);
    await screen.seen('Pick the accounts that take part');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
    await screen.press(ENTER);
    // N333: the list of the step has the choice made here: Opus off, Sonnet from the preset, Haiku on.
    const executors = await screen.seen('Check the models that become Executors');
    expect(executors).toContain('[ ] claude-opus-4-1');
    expect(executors).toContain('[x] claude-sonnet-4-5');
    expect(executors).toContain('[x] claude-haiku-4-5');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    expect(api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: {
        executors: [{ profileId: WORK, model: 'claude-haiku-4-5', effort: 'medium' }],
        budgets: [],
        exclude: [OPUS],
      },
    });
  });

  it('starts with nothing checked under ui.setup.modelPick none, and Esc keeps the preset', async () => {
    const { api } = withModels(() => listed());
    const screen = await addWork(api, 'none');
    const list = await screen.seen('Models of claude-code/work');
    expect(list).toContain('[ ] claude-opus-4-1');
    expect(list).toContain('[ ] claude-sonnet-4-5');
    const left = await screen.press(ESC);
    expect(left).toContain('the list was left; the preset decides its Executors');
    expect(left).not.toContain('Models of');
    await screen.press(ENTER);
    await screen.press(ENTER);
    await screen.press(ENTER);
    // N333: Esc kept the preset, so the list of the step has what the preset uses checked.
    const executors = await screen.seen('Check the models that become Executors');
    expect(executors).toContain('[x] claude-opus-4-1');
    expect(executors).toContain('[x] claude-sonnet-4-5');
    expect(executors).toContain('[ ] claude-haiku-4-5');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    expect(api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: { executors: [], budgets: [] },
    });
  });

  it('asks again when the client says the account is not logged in: L logs in once more', async () => {
    const { api, accounts } = withModels((call) => listed(call === 0 ? 'logged_out' : 'logged_in'));
    const screen = await addWork(api);
    const check = await screen.seen('claude-code/work is not logged in yet');
    expect(check).toContain('L logs in again · S goes on without the login');
    expect(check).toContain('L  Log in again   S  Go on');
    await screen.press('l');
    await screen.seen('Models of claude-code/work');
    expect(accounts.ran).toEqual([
      `ot profile exec ${WORK} login`,
      `ot profile exec ${WORK} login`,
    ]);
    expect(accounts.logins.filter((entry) => entry.startsWith('models:'))).toHaveLength(2);
  });

  it('goes on without the login with S, and the step stays as before', async () => {
    const { api } = withModels(() => listed('logged_out'));
    const screen = await addWork(api);
    await screen.seen('claude-code/work is not logged in yet');
    const on = await screen.press('s');
    expect(on).toContain('claude-code/work goes on without the login');
    expect(on).toContain('Added in this run: claude-code/work');
    expect(on).not.toContain('Models of');
  });

  it('says why there is no list when the client could not list the models', async () => {
    const { api } = withModels(() => ({
      ...listed(),
      catalog: 'unavailable',
      reason: 'the client did not answer',
      models: [],
    }));
    const screen = await addWork(api);
    const frame = (await screen.seen('did not list its models'))
      .replace(/[│\n]/g, ' ')
      .replace(/\s+/g, ' ');
    expect(frame).toContain('(the client did not answer)');
    expect(frame).not.toContain('Models of');
  });

  it('keeps the sign-in message when there is nothing to choose, and says when the list fails', async () => {
    const none = withModels(() => ({ ...listed(), catalog: 'none', models: [] }));
    const quiet = await addWork(none.api);
    const frame = await quiet.seen('The sign-in ended with code 0.');
    expect(frame).not.toContain('Models of');
    cleanup();
    const failing = withModels(() => listed());
    failing.accounts.failModels = new Error('daemon gone');
    const loud = await addWork(failing.api);
    const failed = (await loud.seen('Could not read the models'))
      .replace(/[│\n]/g, ' ')
      .replace(/\s+/g, ' ');
    expect(failed).toContain('daemon gone');
  });
});

describe('SetupScreen looks for the clients and installs an adapter (P18b, N321)', () => {
  const ADAPTER_MISSING: readonly SetupDetectedClient[] = [
    { client: 'claude-code', installed: true, reason: 'found_in_path' },
    { client: 'codex', installed: false, reason: 'adapter_missing' },
  ];
  const NOT_FOUND: readonly SetupDetectedClient[] = [
    { client: 'claude-code', installed: true, reason: 'found_in_path' },
    { client: 'codex', installed: false, reason: 'not_found' },
  ];

  /** The frame as one line: a long text wraps inside the box. */
  function flat(frame: string): string {
    return frame.replace(/[│\n]/g, ' ').replace(/\s+/g, ' ');
  }

  async function atStep(options: Partial<FakeSetupOptions>): Promise<{
    api: FakeSetupApi;
    accounts: FakeSetupAccounts;
    screen: Mounted;
  }> {
    const api = new FakeSetupApi({ profiles: PROFILES, withAccounts: true, ...options });
    const accounts = api.accounts;
    if (accounts === undefined) throw new Error('the fake has no accounts');
    const screen = mount('first_run', api);
    await screen.seen('Add an account of a client');
    return { api, accounts, screen };
  }

  it('says why each client is not there, and what to do under the cursor', async () => {
    const { screen } = await atStep({ clients: ADAPTER_MISSING });
    const first = screen.frame();
    expect(first).toContain('claude-code  (installed)');
    expect(flat(first)).toContain('codex (the program is here, its ACP adapter is not)');
    const second = flat(await screen.press(DOWN));
    expect(second).toContain('I installs the ACP adapter of codex.');
    expect(second).toContain('Install adapter');
  });

  it('A on a client that is not found warns briefly and adds no account', async () => {
    const { api, accounts, screen } = await atStep({ clients: NOT_FOUND });
    await screen.press(DOWN);
    const frame = flat(await screen.press('a'));
    expect(frame).toContain('codex is not ready on this machine (not found)');
    expect(frame).toContain('Install codex, then press R to look again.');
    expect(frame).not.toContain('Account of codex as');
    // No `ot` command in the texts of the assistant (N321).
    expect(frame).not.toMatch(/\bot [a-z]/);
    expect(accounts.added).toEqual([]);
    expect(api.calls.some((call) => call.startsWith('install:'))).toBe(false);
  });

  it('I installs the adapter with its progress, and the client is there after it', async () => {
    let open: () => void = () => undefined;
    const { api, screen } = await atStep({ clients: ADAPTER_MISSING });
    api.installGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await screen.press(DOWN);
    await screen.press('i');
    const running = await screen.seen(/Installing the ACP adapter of codex… \d+ s/);
    expect(running).not.toContain('is installed');
    expect(api.calls).toContain('install:codex');
    open();
    const done = flat(await screen.seen('is installed'));
    expect(done).toContain('The ACP adapter of codex is installed (codex-acp 1.2.3).');
    expect(done).toContain('codex (installed, adapter by OTheater)');
    expect(done).not.toContain('Installing the ACP adapter');
  });

  it('a failed install says why, and the client stays as it was', async () => {
    const { api, screen } = await atStep({ clients: ADAPTER_MISSING });
    api.installFailure = 'the registry answered 500';
    await screen.press(DOWN);
    await screen.press('i');
    const frame = flat(await screen.seen('could not be installed'));
    expect(frame).toContain(
      'The adapter codex-acp could not be installed: the registry answered 500. I tries again.',
    );
    expect(frame).toContain('codex (the program is here, its ACP adapter is not)');
  });

  it('a daemon that refuses the install is shown too', async () => {
    const { api, screen } = await atStep({ clients: ADAPTER_MISSING });
    api.failNext = requestError('unavailable', 503, 'No adapter manager here.');
    await screen.press(DOWN);
    await screen.press('i');
    const frame = flat(await screen.seen('could not be installed'));
    expect(frame).toContain('No adapter manager here.');
  });

  it('I says when there is nothing to install', async () => {
    const { api, screen } = await atStep({ clients: NOT_FOUND });
    expect(flat(await screen.press('i'))).toContain('claude-code is ready: it needs no install.');
    await screen.press(DOWN);
    const frame = flat(await screen.press('i'));
    expect(frame).toContain(
      'The assistant installs only the ACP adapter of a client whose program',
    );
    expect(frame).toContain('Install codex, then press R to look again.');
    expect(api.calls.some((call) => call.startsWith('install:'))).toBe(false);
  });

  it('I on a daemon without the route says it cannot install here', async () => {
    const { screen } = await atStep({ clients: ADAPTER_MISSING, noClientRoutes: true });
    await screen.press(DOWN);
    expect(flat(await screen.press('i'))).toContain('This daemon cannot install adapters here.');
  });

  it('R looks for the clients again and lists the one found now', async () => {
    const { api, screen } = await atStep({ clients: NOT_FOUND });
    api.foundNext = ['codex'];
    await screen.press('r');
    const frame = flat(await screen.seen('Found now: codex.'));
    expect(frame).toContain('codex (installed)');
    expect(api.calls).toContain('redetect');
  });

  it('R on a daemon without the route only reads the step again', async () => {
    const { api, screen } = await atStep({ clients: NOT_FOUND, noClientRoutes: true });
    await screen.press('r');
    await screen.seen('Add an account of a client');
    expect(api.calls).not.toContain('redetect');
  });
});

describe('the setup screen: the list of Executors and the roles of the review (N333)', () => {
  const MAIN = 'claude-code/main';
  const WORK = 'codex/work';
  const SOL_HIGH = `codex-sol-high@${WORK}`;
  const SONNET = `claude-sonnet@${MAIN}`;

  function model(id: string, extra: Partial<SetupModel> = {}): SetupModel {
    return {
      id,
      name: null,
      family: null,
      efforts: [],
      local: false,
      contextWindow: null,
      floating: null,
      preset: [],
      registered: [],
      ...extra,
    };
  }

  function catalogOf(profileId: string): SetupModels {
    const base = {
      profileId,
      kind: 'token_plan' as const,
      login: 'logged_in' as const,
      preset: 'balanced' as const,
      reason: null,
      notes: [],
    };
    if (profileId === MAIN) {
      return {
        ...base,
        catalog: 'listed',
        models: [
          model('claude-sonnet-4-5', { preset: [{ id: SONNET, effort: null }] }),
          model('claude-haiku-4-5'),
        ],
      };
    }
    return {
      ...base,
      catalog: 'listed',
      models: [
        model('gpt-sol', {
          efforts: ['low', 'medium', 'high', 'xhigh'],
          preset: [{ id: SOL_HIGH, effort: 'high' }],
        }),
        model('gpt-mini'),
      ],
    };
  }

  function executorOf(id: string, profileId: string, modelId: string, effort: string | null) {
    return {
      id,
      profileId,
      model: modelId,
      alias: id.slice(0, id.indexOf('@')).replace(effort === null ? /$^/ : `-${effort}`, ''),
      effort,
      provider: 'fake',
      source: 'discovered' as const,
      presetExpand: true,
      local: null,
    } satisfies SetupExecutor;
  }

  /** A daemon where both accounts list their models, and the preset gives roles to two Executors. */
  function listing(): FakeSetupApi {
    const api = new FakeSetupApi({ profiles: PROFILES.slice(0, 2), withAccounts: true });
    if (api.accounts === undefined) throw new Error('the fake has no accounts');
    api.accounts.modelsOf = catalogOf;
    api.planExecutors = [
      executorOf(SOL_HIGH, WORK, 'gpt-sol', 'high'),
      executorOf(SONNET, MAIN, 'claude-sonnet-4-5', null),
    ];
    const roles = (
      [
        ['director', [SONNET]],
        ['author', [SOL_HIGH]],
        ['reviewer', [SOL_HIGH, SONNET]],
        ['actor', [SONNET]],
      ] as const
    ).map(([role, executors]) => ({
      role,
      executors: [...executors],
      whenExhausted: 'next' as const,
    }));
    api.planRoles = roles;
    api.presetRoles = roles;
    return api;
  }

  async function atList(
    api: FakeSetupApi = listing(),
    executorsInput?: SetupExecutorsInputMode,
  ): Promise<Mounted> {
    const screen = mount('first_run', api, undefined, executorsInput);
    await screen.seen('Add an account of a client');
    await screen.press(ENTER);
    await screen.seen('Pick the accounts that take part');
    await screen.press(ENTER);
    await screen.seen('Pick the preset of the roles.');
    await screen.press(ENTER);
    return screen;
  }

  it('lists the models of each account, with what the preset uses checked and its roles beside', async () => {
    const api = listing();
    const screen = await atList(api);
    const frame = await screen.seen('Check the models that become Executors');
    expect(api.accounts?.logins).toEqual([`models:${MAIN}`, `models:${WORK}`]);
    expect(frame).toContain('[x] claude-sonnet-4-5  → director, reviewer, actor');
    expect(frame).toContain('[ ] claude-haiku-4-5  ‹medium›');
    expect(frame).toContain('[x] gpt-sol  ‹high›  → author, reviewer');
    expect(frame).toContain('[ ] gpt-mini  ‹medium›');
    expect(frame).toContain('/  Type');
    expect(frame).toContain('Space  Pick');
  });

  it('Space checks and unchecks, and the arrows change the effort among the ones the model takes', async () => {
    const api = listing();
    const screen = await atList(api);
    await screen.seen('Check the models that become Executors');
    // Down to Haiku, check it; it starts at medium and goes to high with Right (it takes only the defaults).
    await screen.press(DOWN);
    await screen.press(' ');
    await screen.press(RIGHT);
    // Down to gpt-sol (row 3): high goes to xhigh and back to medium with two Left presses from high.
    await screen.press(DOWN);
    const sol = await screen.press(RIGHT);
    expect(sol).toContain('[x] gpt-sol  ‹xhigh›');
    await screen.press(LEFT);
    await screen.press(LEFT);
    // Down to gpt-mini, check it.
    await screen.press(DOWN);
    await screen.press(' ');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    expect(api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: {
        executors: [
          { profileId: MAIN, model: 'claude-haiku-4-5', effort: 'high' },
          { profileId: WORK, model: 'gpt-sol', effort: 'medium', alias: 'codex-sol' },
          { profileId: WORK, model: 'gpt-mini', effort: 'medium' },
        ],
        budgets: [],
        exclude: [SOL_HIGH],
      },
    });
  });

  it('unchecking what the preset uses leaves it out, and the preset name stays when nothing changes', async () => {
    const api = listing();
    const screen = await atList(api);
    await screen.seen('Check the models that become Executors');
    await screen.press(' ');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    expect(api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: { executors: [], budgets: [], exclude: [SONNET] },
    });
  });

  it('with the list on, A points to the / key, and / types the line as before', async () => {
    const api = listing();
    const screen = await atList(api);
    await screen.seen('Check the models that become Executors');
    const warned = await screen.press('a');
    expect(warned).toContain('write the Executor with the / key');
    expect(warned).not.toContain('Executor as:');
    const prompt = await screen.press('/');
    expect(prompt).toContain('Executor as: <account> <model> [effort]');
    await screen.type('openrouter/key some-model high');
    await screen.press(ENTER);
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    const sent = api.submissions.at(-1);
    expect(sent).toMatchObject({
      step: 'executors',
      input: { executors: [{ profileId: 'openrouter/key', model: 'some-model', effort: 'high' }] },
    });
  });

  it('ui.setup.executorsInput prompt keeps the typed line and never reads the models', async () => {
    const api = listing();
    const screen = await atList(api, 'prompt');
    const frame = await screen.seen('Register Executors by API or local model');
    expect(frame).not.toContain('Check the models');
    expect(api.accounts?.logins).toEqual([]);
    const prompt = await screen.press('a');
    expect(prompt).toContain('Executor as: <account> <model> [effort]');
  });

  it('a client that does not list the models says so, and A still types the line', async () => {
    const api = listing();
    if (api.accounts === undefined) throw new Error('the fake has no accounts');
    api.accounts.modelsOf = (profileId) => ({
      ...catalogOf(profileId),
      catalog: 'none',
      models: [],
    });
    const screen = await atList(api);
    const frame = await screen.seen('has no client that lists models');
    expect(frame).toContain('Register Executors by API or local model');
    const prompt = await screen.press('a');
    expect(prompt).toContain('Executor as: <account> <model> [effort]');
  });

  it('a list that fails to be read is said, and the step goes on with the typed line', async () => {
    const api = listing();
    if (api.accounts === undefined) throw new Error('the fake has no accounts');
    api.accounts.failModels = new Error('the client did not answer');
    const screen = await atList(api);
    const frame = await screen.seen('Could not read the models');
    expect(frame).toContain('the client did not answer');
    // The other account is listed all the same.
    expect(frame).toContain('gpt-sol');
  });

  /** From the list to the review with Haiku checked: it enters the plan with no role. */
  async function atReview(api: FakeSetupApi): Promise<Mounted> {
    const screen = await atList(api);
    await screen.seen('Check the models that become Executors');
    await screen.press(DOWN);
    await screen.press(' ');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    return screen;
  }

  it('the review marks the Executor with no role and P gives it roles at the end of their lists', async () => {
    const api = listing();
    const screen = await atReview(api);
    const review = screen.frame();
    expect(review).toContain('no role');
    expect(review).toContain('P gives roles');
    expect(review).toContain('P  Give role');
    const list = await screen.press('p');
    expect(list).toContain('Roles of claude-haiku-4-5@claude-code/main');
    for (const role of [
      'director',
      'consultant',
      'author',
      'reviewer',
      'scriptwriter',
      'critic',
      'actor',
    ]) {
      expect(list).toContain(`[ ] ${role}`);
    }
    expect(list).toContain('Enter  Give the roles');
    // Down twice to author, check it, down once and check the reviewer.
    await screen.press(DOWN);
    await screen.press(DOWN);
    await screen.press(' ');
    await screen.press(DOWN);
    const checked = await screen.press(' ');
    expect(checked).toContain('[x] author');
    expect(checked).toContain('[x] reviewer');
    const calls = api.calls.length;
    await screen.press(ENTER);
    const done = await screen.seen('joined the end of the list of: author, reviewer.');
    expect(api.calls.slice(calls)).toEqual(['back', 'submit:executors']);
    expect(api.submissions.at(-1)).toEqual({
      step: 'executors',
      input: {
        executors: [{ profileId: MAIN, model: 'claude-haiku-4-5', effort: 'medium' }],
        budgets: [],
        exclude: [],
        roles: [
          {
            executorId: 'claude-haiku-4-5@claude-code/main',
            roles: ['author', 'reviewer'],
          },
        ],
      },
    });
    // The Executor has roles now: it is no longer without one.
    expect(done).not.toContain('P gives roles');
    expect(done).toContain('author');
  });

  it('Esc closes the list of roles and sends nothing; Enter with none checked does the same', async () => {
    const api = listing();
    const screen = await atReview(api);
    const calls = api.calls.length;
    await screen.press('p');
    const left = await screen.press(ESC);
    expect(left).not.toContain('Roles of');
    await screen.press('p');
    await screen.press(ENTER);
    expect(screen.frame()).not.toContain('Roles of');
    expect(api.calls).toHaveLength(calls);
  });

  it('a daemon that refuses the roles shows why and leaves the run at the step of the Executors', async () => {
    const api = listing();
    const screen = await atReview(api);
    const submit = api.submit.bind(api);
    let first = true;
    api.submit = (runId, body) => {
      if (first && body.step === 'executors') {
        first = false;
        return Promise.reject(requestError('invalid_input', 400, 'The role is not accepted.'));
      }
      return submit(runId, body);
    };
    await screen.press('p');
    await screen.press(' ');
    await screen.press(ENTER);
    const frame = await screen.seen('The role is not accepted.');
    expect(frame).toContain('Check the models that become Executors');
    // The choice of the step is still there: Haiku is checked.
    expect(frame).toContain('[x] claude-haiku-4-5');
  });

  it('with no Executor without a role, P says so', async () => {
    const api = listing();
    const screen = await atList(api);
    await screen.seen('Check the models that become Executors');
    await screen.press(ENTER);
    await screen.seen('This is what will be written.');
    const frame = await screen.press('p');
    expect(frame).toContain('No Executor with no role to give roles to.');
    expect(frame).not.toContain('Roles of');
  });
});
