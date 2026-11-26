// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError, deriveShortcutBar, type UiBarItem } from '@otheater/client';
import type { AddProfileBody, SetupAdapterClient, SetupRunView } from '@otheater/protocol';
import { Box, useWindowSize } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../layout/themed-text.js';
import { keyLabel } from '../keys/labels.js';
import { useRawKeys, type KeyEvent, type TuiKeymap } from '../keys/use-keymap.js';
import { Frame } from '../layout/frame.js';
import { ShortcutBar } from '../layout/shortcut-bar.js';
import { fit, wrapText } from '../layout/text.js';
import { TOKEN, paint } from '../layout/theme.js';
import { useSuspendTerminal } from '../mouse/index.js';
import { useRenderControl } from '../render-control.js';
import { fieldStep } from '../tabs/settings/field.js';
import { errorText, runInTerminal } from '../tabs/settings/index.js';
import type { SetupReviewNotesMode } from '../settings.js';
import type { SetupApi, SetupFlow } from './api.js';
import {
  accountFormKey,
  accountFormLines,
  accountFormStart,
  unknownClientText,
  type AccountForm,
} from './account-form.js';
import { clientStateText, clientTodoText, setupLines, type SetupLine } from './lines.js';
import {
  accountClients,
  accountsCursorMoved,
  accountsCursorStart,
  adapterToInstall,
  atFirstStep,
  draftKey,
  executorsItem,
  initialDraft,
  isFinished,
  loginCommandOf,
  parseBudgetLine,
  parseExecutorLine,
  reordered,
  stepNumber,
  submissionOf,
  toggled,
  withBudget,
  withCursor,
  withExecutor,
  withoutExecutor,
  type Draft,
} from './model.js';

/**
 * The screen of the setup assistant (architecture 5.7; N121; P17 of Phase 7). The steps, their
 * order and what each one accepts are the daemon's (P4): this screen draws the view of the run the
 * daemon holds, sends the answer of each step, goes back, resumes and confirms, and shows what the
 * daemon refuses as it said it. [proposta] It is a screen of its own (it takes the whole terminal,
 * with the keys of the context `setup`) and not a tab: the first run has no layout worth showing
 * yet, and "add account" and "change preset" are the same screen with another flow.
 *
 * Leaving without cancelling (Esc at the first step, or the TUI closing) keeps the run in the
 * daemon: the next time the screen opens for the flow it resumes at the same step.
 */

export type SetupOutcome = 'left' | 'confirmed' | 'cancelled';

export interface SetupScreenProps {
  readonly flow: SetupFlow;
  readonly api: SetupApi;
  readonly keymap: TuiKeymap;
  /** The screen is done: the run was left (kept), confirmed or cancelled. */
  readonly onClose: (outcome: SetupOutcome) => void;
  /** `ui.setup.reviewNotes` (N324): how the review shows its notes at first; `grouped` by default. */
  readonly reviewNotes?: SetupReviewNotesMode | undefined;
}

type Tone = 'ok' | 'warn' | 'error';

type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'prompt';
      readonly purpose: 'executor' | 'budget';
      /** The account of the cap (`budget`). */
      readonly profileId: string;
      readonly value: string;
    }
  /** The form "Adicionar conta" (N326): the same one the tab Settings opens with A. */
  | { readonly kind: 'form'; readonly form: AccountForm }
  | { readonly kind: 'confirmCancel' }
  /** A second subscription of one provider: the daemon wants the notice accepted (N127). */
  | {
      readonly kind: 'confirmNotice';
      readonly body: AddProfileBody;
      readonly provider: string;
      readonly existing: readonly string[];
    };

interface State {
  readonly load: 'loading' | 'ready' | 'failed';
  readonly loadError: string | undefined;
  readonly run: SetupRunView | undefined;
  readonly draft: Draft;
  readonly mode: Mode;
  readonly busy: boolean;
  readonly message: { readonly text: string; readonly tone: Tone } | undefined;
  /** The step that adds an account (N274) is on screen, or it is behind the person. */
  readonly stage: 'accounts' | 'steps';
  /** The client under the cursor of that step. */
  readonly accountsCursor: number;
  /** The accounts added in this run. */
  readonly added: readonly string[];
  /** The install of an adapter that runs now (P18b, the I key), and since when (ms). */
  readonly installing: { readonly client: string; readonly since: number } | undefined;
  /** The review shows every note (N324); otherwise it folds them. */
  readonly details: boolean;
}

const IDLE: Mode = { kind: 'idle' };
const TONE_COLOR: Readonly<Record<Tone, string>> = {
  ok: TOKEN.ok,
  warn: TOKEN.warn,
  error: TOKEN.error,
};

const FIRST: State = {
  load: 'loading',
  loadError: undefined,
  run: undefined,
  draft: { kind: 'review' },
  mode: IDLE,
  busy: false,
  message: undefined,
  stage: 'steps',
  accountsCursor: 0,
  added: [],
  installing: undefined,
  details: false,
};

/** An account exists already: added in this run, or found by the detection. */
function accountExists(run: SetupRunView, added: readonly string[]): boolean {
  return added.length > 0 || (run.prompt?.step === 'detect' && run.prompt.profiles.length > 0);
}

/** The hints of the bar that make sense at the step on screen. */
/** The bar while the form is open: its own keys, fixed as the form reads them (N326). */
const FORM_BAR: readonly UiBarItem[] = [
  { id: 'accountForm.submit', label: 'Enter', text: { key: 'bar.accountForm.submit' } },
  { id: 'accountForm.next', label: 'Tab', text: { key: 'bar.accountForm.next' } },
  { id: 'accountForm.change', label: 'Space', text: { key: 'bar.accountForm.change' } },
  { id: 'accountForm.cancel', label: 'Esc', text: { key: 'bar.accountForm.cancel' } },
];

function relevantBar(
  item: UiBarItem,
  step: string | undefined,
  finished: boolean,
  accounts: boolean,
  hasAccount: boolean,
): boolean {
  if (finished) return item.id === 'setup.advance';
  if (accounts) {
    // N326: S continues without an account only where there is none yet.
    if (item.id === 'setup.skip') return !hasAccount;
    return ![
      'setup.toggle',
      'setup.edit',
      'setup.remove',
      'setup.moveUp',
      'setup.moveDown',
      'setup.details',
    ].includes(item.id);
  }
  switch (item.id) {
    case 'setup.install':
    case 'setup.skip':
      return false;
    case 'setup.toggle':
      return step === 'detect';
    case 'setup.details':
      return step === 'review';
    case 'setup.add':
    case 'setup.edit':
      return step === 'executors';
    default:
      return true;
  }
}

export function SetupScreen(props: SetupScreenProps): ReactNode {
  const { flow, api, keymap, onClose } = props;
  const { t } = useTranslation();
  const { columns, rows } = useWindowSize();
  const { afterKey } = useRenderControl();
  const suspendTerminal = useSuspendTerminal();
  // The step that adds an account exists in the first run, when the API has the routes for it.
  const accountsOn = flow === 'first_run' && api.accounts !== undefined;

  const start: State = { ...FIRST, details: props.reviewNotes === 'all' };
  const [state, setState] = useState<State>(start);
  // While an adapter installs, the screen draws the seconds it has taken, once a second.
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<State>(start);
  const alive = useRef(true);
  // The draft of each step already answered, to bring back when the person goes back to it.
  const memory = useRef(new Map<string, Draft>());

  const update = (patch: Partial<State>): void => {
    const next = { ...ref.current, ...patch };
    ref.current = next;
    if (alive.current) setState(next);
  };

  const say = (text: string, tone: Tone): void => {
    update({ message: { text, tone } });
  };

  /** Shows the view the daemon gave: the draft is the one remembered for the step, or a fresh one. */
  const show = (run: SetupRunView, message?: State['message']): void => {
    const remembered = memory.current.get(draftKey(run));
    const fresh = initialDraft(run.prompt);
    update({
      load: 'ready',
      loadError: undefined,
      run,
      draft: remembered?.kind === fresh.kind ? remembered : fresh,
      mode: IDLE,
      busy: false,
      message,
    });
  };

  const refused = (error: unknown): void => {
    update({
      busy: false,
      message: { text: t('setup.refused', { message: errorText(error) }), tone: 'error' },
    });
  };

  /** The run of the flow the daemon holds in progress, or a new one. */
  const open = async (): Promise<void> => {
    update({ load: 'loading', loadError: undefined, busy: true });
    try {
      const activeOf = async (): Promise<SetupRunView | null> => {
        const overview = await api.overview();
        return overview.flows.find((entry) => entry.flow === flow)?.active ?? null;
      };
      let run = await activeOf();
      const resumed = run !== null;
      if (run === null) {
        try {
          run = await api.start(flow);
        } catch (error) {
          // Another client started the flow between the read and the start: take that run.
          if (!(error instanceof ApiRequestError) || error.code !== 'conflict') throw error;
          run = await activeOf();
          if (run === null) throw error;
        }
      }
      // The first step of the run is the one the step that adds an account stands before.
      update({
        stage: accountsOn && run.state === 'active' && run.step === 'detect' ? 'accounts' : 'steps',
        accountsCursor: accountsCursorStart(run.prompt),
      });
      show(
        run,
        resumed && !(accountsOn && run.step === 'detect')
          ? {
              text: t('setup.resumed', { step: t(`setup.step.${run.step}`) }),
              tone: 'warn',
            }
          : undefined,
      );
    } catch (error) {
      update({ load: 'failed', loadError: errorText(error), busy: false });
    }
  };

  useEffect(() => {
    if (state.installing === undefined) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [state.installing]);

  useEffect(() => {
    alive.current = true;
    void open();
    return () => {
      alive.current = false;
    };
    // The screen opens once per flow it is mounted for.
  }, []);

  /** Runs one command of the daemon over the run; a conflict (the run moved elsewhere) reloads it. */
  const command = async (
    run: SetupRunView,
    call: () => Promise<SetupRunView>,
    after?: (next: SetupRunView) => void,
  ): Promise<void> => {
    update({ busy: true, message: undefined });
    try {
      const next = await call();
      if (!alive.current) return;
      show(next);
      after?.(next);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'conflict') {
        await reread(run, {
          text: t('setup.refused', { message: errorText(error) }),
          tone: 'error',
        });
        return;
      }
      refused(error);
    }
  };

  /** Reads the run again from the daemon and shows it (R, or after a conflict). */
  const reread = async (
    run: SetupRunView | undefined,
    message?: State['message'],
  ): Promise<void> => {
    memory.current.clear();
    update({ busy: true });
    try {
      const overview = await api.overview();
      const active = overview.flows.find((entry) => entry.flow === flow)?.active ?? null;
      if (active === null) {
        if (run !== undefined && ref.current.load === 'ready') {
          // The run ended elsewhere: nothing left to answer here.
          onClose('left');
          return;
        }
        await open();
        return;
      }
      show(active, message);
    } catch (error) {
      if (ref.current.load === 'ready') refused(error);
      else update({ load: 'failed', loadError: errorText(error), busy: false });
    }
  };

  const advance = (run: SetupRunView, draft: Draft): void => {
    if (isFinished(run)) {
      onClose(run.state === 'confirmed' ? 'confirmed' : 'cancelled');
      return;
    }
    if (run.step === 'review') {
      void command(run, () => api.confirm(run.id));
      return;
    }
    const body = submissionOf(draft, run.prompt);
    if (body === undefined) return;
    memory.current.set(draftKey(run), draft);
    void command(run, () => api.submit(run.id, body));
  };

  const back = (run: SetupRunView): void => {
    if (isFinished(run)) {
      onClose(run.state === 'confirmed' ? 'confirmed' : 'cancelled');
      return;
    }
    if (atFirstStep(run)) {
      // Behind the detection stands the step that adds an account; the run has nothing before it.
      if (accountsOn && ref.current.stage === 'steps') update({ stage: 'accounts' });
      else onClose('left');
      return;
    }
    void command(run, () => api.back(run.id));
  };

  /** Shows the run as the daemon holds it now (the accounts it lists changed), with a message. */
  const refresh = async (message: NonNullable<State['message']>): Promise<void> => {
    try {
      const overview = await api.overview();
      const active = overview.flows.find((entry) => entry.flow === flow)?.active ?? null;
      if (!alive.current) return;
      if (active !== null) {
        show(active, message);
        return;
      }
    } catch {
      // The account was added all the same: say it; the list is read again with the reload key.
    }
    update({ busy: false, message });
  };

  /**
   * Looks for the clients again, then reads the step again (R; P18, N321): a client installed
   * while the assistant is open shows up without a restart. A daemon without the route only reads.
   */
  const lookAgain = async (run: SetupRunView): Promise<void> => {
    let message: State['message'];
    if (api.redetect !== undefined) {
      update({ busy: true, message: undefined });
      try {
        const result = await api.redetect();
        if (result.added.length > 0) {
          message = {
            text: t('setup.redetect.added', { list: result.added.join(', ') }),
            tone: 'ok',
          };
        }
      } catch (error) {
        message = { text: t('setup.redetect.failed', { message: errorText(error) }), tone: 'warn' };
      }
      if (!alive.current) return;
    }
    await reread(run, message);
  };

  /**
   * Installs the ACP adapter of the client (I; P18b, N321), then the daemon looks again, so the
   * client is there when it ends. [proposta] The screen waits for the answer and shows the seconds
   * it takes; a failed download says why, and I tries again.
   */
  const installOf = async (client: SetupAdapterClient): Promise<void> => {
    const install = api.installAdapter;
    if (install === undefined) {
      say(t('setup.install.unavailable'), 'warn');
      return;
    }
    update({ busy: true, message: undefined, installing: { client, since: Date.now() } });
    let message: NonNullable<State['message']>;
    try {
      const result = await install(client);
      message = result.installed
        ? {
            text: t('setup.install.done', {
              client,
              adapter: result.adapter,
              version: result.version,
            }),
            tone: 'ok',
          }
        : {
            text: t('setup.install.failed', {
              adapter: result.adapter,
              message: result.failure ?? '',
              key: keyLabel(keymap, 'setup.install') ?? '',
            }),
            tone: 'error',
          };
    } catch (error) {
      message = {
        text: t('setup.install.failed', {
          adapter: client,
          message: errorText(error),
          key: keyLabel(keymap, 'setup.install') ?? '',
        }),
        tone: 'error',
      };
    }
    if (!alive.current) return;
    update({ installing: undefined });
    await refresh(message);
  };

  /**
   * Logs in to the account just added, the same login as the key L of Settings › Assinaturas: a
   * client that needs a terminal is run with the terminal handed over (`useSuspendTerminal`, so the
   * mouse comes back). [proposta] A login the daemon runs itself (`started`) is not followed here,
   * because this screen has no events: it is cancelled and run in the terminal instead.
   */
  const loginOf = async (profileId: string): Promise<NonNullable<State['message']>> => {
    const accounts = api.accounts;
    const command = loginCommandOf(profileId);
    try {
      if (accounts === undefined) throw new Error('no accounts API');
      const started = await accounts.startLogin(profileId);
      if (started.status === 'started') await accounts.cancelLogin(profileId);
      const runLocal = accounts.runLocal ?? runInTerminal;
      const exit: { code: number | null } = { code: null };
      await suspendTerminal(async () => {
        exit.code = await runLocal(started.status === 'local' ? started.command : command);
      });
      return {
        text: t('setup.accounts.result.loginDone', { profile: profileId, code: String(exit.code) }),
        tone: exit.code === 0 ? 'ok' : 'warn',
      };
    } catch (error) {
      return {
        text: t('setup.accounts.result.loginFailed', {
          profile: profileId,
          message: errorText(error),
        }),
        tone: 'error',
      };
    }
  };

  /**
   * Adds the account; a subscription logs in at once (N274), an API account has no login (its key
   * went with it).
   */
  const addAccount = async (body: AddProfileBody): Promise<void> => {
    const accounts = api.accounts;
    if (accounts === undefined) return;
    update({ busy: true, message: undefined, mode: IDLE });
    let message: NonNullable<State['message']>;
    try {
      const result = await accounts.addProfile(body);
      if (!alive.current) return;
      if (result.status === 'needs_notice') {
        update({
          busy: false,
          mode: {
            kind: 'confirmNotice',
            body,
            provider: result.notice.provider,
            existing: result.notice.existing,
          },
        });
        return;
      }
      const profileId = result.profile.id;
      update({ added: [...ref.current.added, profileId] });
      message =
        body.kind === 'api'
          ? { text: t('setup.accounts.result.added', { profile: profileId }), tone: 'ok' }
          : result.login === 'logged_in'
            ? { text: t('setup.accounts.result.loggedIn', { profile: profileId }), tone: 'ok' }
            : await loginOf(profileId);
    } catch (error) {
      if (!alive.current) return;
      update({
        busy: false,
        message: {
          text: t('setup.accounts.result.failed', {
            message: unknownClientText(error, t) ?? errorText(error),
          }),
          tone: 'error',
        },
      });
      return;
    }
    await refresh(message);
  };

  const submitPrompt = (current: Extract<Mode, { kind: 'prompt' }>, draft: Draft): void => {
    if (current.purpose === 'executor') {
      const executor = parseExecutorLine(current.value);
      if (executor === undefined) {
        update({ mode: IDLE });
        say(t('setup.prompt.badExecutor'), 'warn');
        return;
      }
      update({ mode: IDLE, draft: withExecutor(draft, executor), message: undefined });
      return;
    }
    const budget = parseBudgetLine(current.profileId, current.value);
    if (budget === undefined) {
      update({ mode: IDLE });
      say(t('setup.prompt.badBudget'), 'warn');
      return;
    }
    update({ mode: IDLE, draft: withBudget(draft, budget), message: undefined });
  };

  const clientKeys = (): { install: string; reload: string } => ({
    install: keyLabel(keymap, 'setup.install') ?? '',
    reload: keyLabel(keymap, 'setup.reload') ?? '',
  });

  const hasAccount = (run: SetupRunView): boolean => accountExists(run, ref.current.added);

  /**
   * Opens the form "Adicionar conta" over the clients ready on the machine (N326), the one under
   * the cursor chosen; with none ready, says how to get one instead.
   */
  const openForm = (run: SetupRunView, preferred?: string): void => {
    const ready = accountClients(run.prompt)
      .filter((entry) => entry.installed)
      .map((entry) => entry.client);
    const form = accountFormStart(ready, preferred);
    if (form === undefined) {
      say(
        t('setup.accounts.noReady', {
          install: keyLabel(keymap, 'setup.install') ?? '',
          reload: keyLabel(keymap, 'setup.reload') ?? '',
          skip: keyLabel(keymap, 'setup.skip') ?? '',
        }),
        'warn',
      );
      return;
    }
    update({ mode: { kind: 'form', form } });
  };

  /** The keys of the step that adds an account. */
  const onAccountsKey = (run: SetupRunView, name: string): void => {
    const cursor = ref.current.accountsCursor;
    switch (name) {
      case 'advance':
        // N324/N326: with no account yet, Enter opens the form; S continues without one.
        if (hasAccount(run)) update({ stage: 'steps' });
        else openForm(run, accountClients(run.prompt)[cursor]?.client);
        return;
      case 'skip':
        update({ stage: 'steps' });
        if (!hasAccount(run)) say(t('setup.accounts.skipped'), 'warn');
        return;
      case 'back':
        onClose('left');
        return;
      case 'itemPrev':
        update({ accountsCursor: accountsCursorMoved(cursor, run.prompt, -1) });
        return;
      case 'itemNext':
        update({ accountsCursor: accountsCursorMoved(cursor, run.prompt, 1) });
        return;
      case 'add': {
        const entry = accountClients(run.prompt)[cursor];
        if (entry === undefined) return;
        // P18b: a client that is not on the machine has no account to add yet; say why, briefly.
        if (run.prompt?.step === 'detect' && !entry.installed) {
          const todo = clientTodoText(entry, clientKeys(), t);
          say(
            t('setup.accounts.cannotAdd', {
              client: entry.client,
              why: clientStateText(entry, t),
              todo: todo ?? '',
            }),
            'warn',
          );
          return;
        }
        openForm(run, entry.client);
        return;
      }
      case 'install': {
        const entry = accountClients(run.prompt)[cursor];
        if (entry === undefined) return;
        const client = adapterToInstall(entry);
        if (client !== undefined) {
          void installOf(client);
          return;
        }
        say(
          entry.installed
            ? t('setup.install.notNeeded', { client: entry.client })
            : t('setup.install.notOffered', {
                client: entry.client,
                todo: clientTodoText(entry, clientKeys(), t) ?? '',
              }),
          'warn',
        );
        return;
      }
      case 'reload':
        void lookAgain(run);
        return;
      case 'cancel':
        update({ mode: { kind: 'confirmCancel' } });
        return;
      default:
        return;
    }
  };

  const onKey = (event: KeyEvent): void => {
    const current = ref.current;
    if (current.busy) return;
    const run = current.run;
    const mode = current.mode;
    if (current.load === 'failed') {
      const action = event.combo === undefined ? undefined : keymap.match(event.combo, ['setup']);
      if (action === 'setup.reload') void open();
      else if (action === 'setup.back') onClose('left');
      return;
    }
    if (run === undefined) return;
    if (mode.kind === 'confirmCancel') {
      update({ mode: IDLE });
      if ((event.combo ?? '').toUpperCase() === t('setup.prompt.yes').toUpperCase()) {
        void command(run, () => api.cancel(run.id));
      }
      return;
    }
    if (mode.kind === 'confirmNotice') {
      update({ mode: IDLE });
      if ((event.combo ?? '').toUpperCase() === t('setup.prompt.yes').toUpperCase()) {
        void addAccount({ ...mode.body, acceptNotice: true });
      }
      return;
    }
    if (mode.kind === 'form') {
      const step = accountFormKey(mode.form, event.combo, event.data);
      if (step.done === 'cancel') update({ mode: IDLE });
      else if (step.done === 'submit') void addAccount(step.body);
      else update({ mode: { kind: 'form', form: step.form } });
      return;
    }
    if (mode.kind === 'prompt') {
      const step = fieldStep(mode.value, event.combo, event.data);
      if (step.done === 'cancel') update({ mode: IDLE });
      else if (step.done === 'submit') submitPrompt(mode, current.draft);
      else update({ mode: { ...mode, value: step.value } });
      return;
    }
    if (event.combo === undefined) return;
    const action = keymap.match(event.combo, ['setup']);
    if (!action?.startsWith('setup.')) return;
    if (current.message !== undefined) update({ message: undefined });
    const draft = current.draft;
    if (accountsOn && current.stage === 'accounts' && run.step === 'detect' && !isFinished(run)) {
      onAccountsKey(run, action.slice('setup.'.length));
      return;
    }
    switch (action.slice('setup.'.length)) {
      case 'advance':
        advance(run, draft);
        return;
      case 'back':
        back(run);
        return;
      case 'itemPrev':
        update({ draft: withCursor(draft, run.prompt, -1) });
        return;
      case 'itemNext':
        update({ draft: withCursor(draft, run.prompt, 1) });
        return;
      case 'toggle':
        update({ draft: toggled(draft) });
        return;
      case 'moveUp':
        update({ draft: reordered(draft, -1) });
        return;
      case 'moveDown':
        update({ draft: reordered(draft, 1) });
        return;
      case 'add':
        if (draft.kind === 'executors') {
          update({ mode: { kind: 'prompt', purpose: 'executor', profileId: '', value: '' } });
        }
        return;
      case 'edit': {
        const item = executorsItem(draft, run.prompt);
        if (item?.kind === 'budget') {
          update({
            mode: { kind: 'prompt', purpose: 'budget', profileId: item.profileId, value: '' },
          });
        }
        return;
      }
      case 'remove': {
        const item = executorsItem(draft, run.prompt);
        if (item?.kind === 'executor') update({ draft: withoutExecutor(draft, item.index) });
        return;
      }
      case 'reload':
        void lookAgain(run);
        return;
      case 'details':
        if (run.step === 'review' && !isFinished(run)) update({ details: !current.details });
        return;
      case 'cancel':
        if (!isFinished(run)) update({ mode: { kind: 'confirmCancel' } });
        return;
      default:
        return;
    }
  };

  useRawKeys((event) => {
    onKey(event);
    afterKey();
  });

  // What it draws.
  const { run, draft, mode, message } = state;
  const finished = run !== undefined && isFinished(run);
  const onAccounts =
    accountsOn && state.stage === 'accounts' && run?.step === 'detect' && !finished;
  const closeKey = keyLabel(keymap, 'setup.advance') ?? '';
  const innerWidth = Math.max(1, columns - 2);
  const innerHeight = Math.max(1, rows - 1 - 2);

  const head: SetupLine[] = [];
  if (mode.kind === 'prompt') {
    head.push({
      key: 'p.label',
      text:
        mode.purpose === 'executor'
          ? t('setup.prompt.executor')
          : t('setup.prompt.budget', { profile: mode.profileId }),
      color: TOKEN.accent,
    });
    head.push({ key: 'p.value', text: `> ${mode.value}▏` });
    head.push({ key: 'p.hint', text: t('setup.prompt.hintEnter'), dim: true });
  } else if (mode.kind === 'form') {
    for (const line of accountFormLines(mode.form, t, { login: true })) {
      head.push({
        key: line.key,
        text: line.text,
        color:
          line.tone === 'accent' ? TOKEN.accent : line.tone === 'warn' ? TOKEN.warn : undefined,
        ...(line.dim === true ? { dim: true } : {}),
        ...(line.selected === true ? { selected: true } : {}),
      });
    }
    head.push({ key: 'f.gap', text: '' });
  } else if (mode.kind === 'confirmNotice') {
    head.push({
      key: 'n.q',
      text: t('setup.prompt.confirmNotice', {
        provider: mode.provider,
        existing: mode.existing.join(', '),
      }),
      color: TOKEN.warn,
    });
    head.push({ key: 'n.hint', text: t('setup.prompt.hintConfirm'), dim: true });
  } else if (mode.kind === 'confirmCancel') {
    head.push({ key: 'c.q', text: t('setup.prompt.confirmCancel'), color: TOKEN.warn });
    head.push({ key: 'c.hint', text: t('setup.prompt.hintConfirm'), dim: true });
  }
  if (message !== undefined) {
    head.push({ key: 'm', text: message.text, color: TONE_COLOR[message.tone] });
  }
  if (state.load === 'loading') {
    head.push({ key: 'load', text: t('setup.loading'), dim: true });
  } else if (state.load === 'failed') {
    head.push({
      key: 'fail',
      text: t('setup.loadFailed', { message: state.loadError ?? '' }),
      color: TOKEN.error,
    });
    head.push({
      key: 'retry',
      text: t('setup.loadRetry', {
        key: keyLabel(keymap, 'setup.reload') ?? '',
        back: keyLabel(keymap, 'setup.back') ?? '',
      }),
      dim: true,
    });
  } else if (state.busy && state.installing === undefined) {
    head.push({ key: 'busy', text: t('setup.busy'), dim: true });
  }

  const body: SetupLine[] =
    run === undefined
      ? []
      : setupLines({
          run,
          draft,
          t,
          closeKey,
          reviewNotes: { all: state.details, key: keyLabel(keymap, 'setup.details') ?? '' },
          accounts: accountsOn
            ? {
                active: onAccounts,
                // While the form is open, its field holds the cursor.
                cursor: mode.kind === 'form' ? -1 : state.accountsCursor,
                added: state.added,
                addKey: keyLabel(keymap, 'setup.add') ?? '',
                nextKey: keyLabel(keymap, 'setup.advance') ?? '',
                skipKey: keyLabel(keymap, 'setup.skip') ?? '',
                hasAccount: accountExists(run, state.added),
                installKey: keyLabel(keymap, 'setup.install') ?? '',
                reloadKey: keyLabel(keymap, 'setup.reload') ?? '',
                installing:
                  state.installing === undefined
                    ? undefined
                    : {
                        client: state.installing.client,
                        seconds: Math.max(0, Math.floor((now - state.installing.since) / 1000)),
                      },
              }
            : undefined,
        });
  if (run !== undefined && !finished && atFirstStep(run) && (!accountsOn || onAccounts)) {
    body.push({ key: 'gap.leave', text: '' });
    body.push({
      key: 'leave',
      text: t('setup.leaveHint', { key: keyLabel(keymap, 'setup.back') ?? '' }),
      dim: true,
    });
  }

  const wrapped: ReactNode[] = [];
  let cursorLine = 0;
  for (const line of [...head, ...body]) {
    if (line.selected === true) cursorLine = wrapped.length;
    const pieces = wrapText(line.text, Math.max(1, innerWidth - 1));
    pieces.forEach((piece, index) => {
      wrapped.push(
        <Text
          key={`${line.key}.${String(index)}`}
          wrap="truncate"
          dimColor={line.dim === true}
          bold={line.bold === true}
          {...paint(line.color, line.selected === true ? TOKEN.selected : undefined)}
        >
          {fit(`${line.selected === true && index === 0 ? '›' : ' '}${piece}`, innerWidth)}
        </Text>,
      );
    });
  }
  const first = Math.max(0, cursorLine - Math.max(1, innerHeight - 1));

  const hasAccountNow = run !== undefined && accountExists(run, state.added);
  const bar =
    mode.kind === 'form'
      ? FORM_BAR
      : deriveShortcutBar(keymap.registry, keymap.keymap, ['setup'])
          .filter((item) => relevantBar(item, run?.step, finished, onAccounts, hasAccountNow))
          .map((item) =>
            // N326: with no account yet, Enter at the step opens the form instead of going on.
            onAccounts && !hasAccountNow && item.id === 'setup.advance'
              ? { ...item, text: { key: 'bar.setup.openForm' } }
              : item,
          );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Frame
        width={columns}
        height={Math.max(3, rows - 1)}
        active
        title={t(`setup.title.${flow}`)}
        titleRight={
          run === undefined
            ? undefined
            : t('setup.stepOf', {
                n: accountsOn ? (onAccounts ? 1 : stepNumber(run) + 1) : stepNumber(run),
                total: run.steps.length + (accountsOn ? 1 : 0),
              })
        }
      >
        <Box flexDirection="column" width={innerWidth}>
          {wrapped.slice(first)}
        </Box>
      </Frame>
      <ShortcutBar width={columns} items={bar} />
    </Box>
  );
}
