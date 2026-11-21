// SPDX-License-Identifier: MPL-2.0
import type { i18n as I18nInstance } from 'i18next';
import { cleanup, render } from 'ink-testing-library';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plain, waitFor } from '../ink.test-support.js';
import { buildTuiKeymap } from '../keys/use-keymap.js';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import type { SetupFlow } from './api.js';
import { FakeSetupApi, profileOf, requestError } from './fake-api.test-support.js';
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
    expect(screen.frame()).not.toContain('Executor as:');
    expect(screen.frame()).toContain('None. Enter continues without one.');
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
