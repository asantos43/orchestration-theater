// SPDX-License-Identifier: MPL-2.0
import type { i18n as I18nInstance } from 'i18next';
import { cleanup, render } from 'ink-testing-library';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain, waitFor } from '../ink.test-support.js';
import { buildTuiKeymap } from '../keys/use-keymap.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type { SetupDetectedClient } from '@otheater/protocol';
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
const SHIFT_DOWN = '\x1b[1;2B';

const keymap = buildTuiKeymap(
  { preset: 'agents', environment: 'auto', overrides: {} },
  { env: {}, platform: 'linux' },
);

/** Both clients on the machine (a test that adds an account of each). */
const BOTH_INSTALLED: readonly SetupDetectedClient[] = [
  { client: 'claude-code', installed: true },
  { client: 'codex', installed: true },
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
): Mounted {
  const outcomes: SetupOutcome[] = [];
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SetupScreen flow={flow} api={api} keymap={keymap} onClose={(o) => outcomes.push(o)} />
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
    expect(review).toContain('gpt-5@codex/work');
    expect(review).toContain('roles.preset');
    await screen.press(ENTER);

    const done = await screen.seen('Done. The configuration was written.');
    expect(done).toContain('Preset: economical');
    expect(done).toContain('Executors registered: gpt-5@codex/work');
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

  async function atStep(api: FakeSetupApi): Promise<Mounted> {
    const screen = mount('first_run', api);
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
    expect(frame).toContain('continues without adding');
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
    expect(screen.frame()).toContain('Account of claude-code as: <name> [provider]');
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
    // The detection lists the account just added.
    const detect = await screen.press(ENTER);
    expect(detect).toContain('claude-code/work');
  });

  it('takes the provider of the line when it has one, and the default of the client otherwise', async () => {
    const { api, accounts } = withAccounts({ clients: BOTH_INSTALLED });
    const screen = await atStep(api);
    await screen.press(DOWN);
    await screen.press('a');
    await screen.type('alt openrouter');
    await screen.press(ENTER);
    await screen.seen('Added in this run: codex/alt');
    expect(accounts.added[0]).toMatchObject({
      client: 'codex',
      name: 'alt',
      provider: 'openrouter',
    });
  });

  it('a line that is not <name> [provider] adds nothing', async () => {
    const { api, accounts } = withAccounts();
    const screen = await atStep(api);
    await screen.press('a');
    await screen.type('a b c');
    await screen.press(ENTER);
    expect(screen.frame()).toContain('Write <name> [provider].');
    expect(accounts.added).toEqual([]);
    expect(accounts.logins).toEqual([]);
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
    await screen.type('work');
    await screen.press(ENTER);
    await screen.seen('Added in this run: claude-code/work');
    await screen.press(DOWN);
    await screen.press('a');
    await screen.type('home');
    await screen.press(ENTER);
    await screen.seen('Added in this run: claude-code/work, codex/home');
    expect(accounts.added.map((body) => `${body.client}/${body.name}`)).toEqual([
      'claude-code/work',
      'codex/home',
    ]);
  });

  it('is only in the first run, not in the other flows', async () => {
    const { api } = withAccounts();
    const screen = mount('add_account', api);
    const first = await screen.seen('Pick the account to bring into the roles.');
    expect(first).toContain('Step 1 of 3');
    expect(first).not.toContain('New account');
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
