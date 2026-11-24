// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError, deriveShortcutBar, type UiBarItem } from '@otheater/client';
import type { AddProfileBody, SetupRunView } from '@otheater/protocol';
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
import type { SetupApi, SetupFlow } from './api.js';
import { setupLines, type SetupLine } from './lines.js';
import {
  accountClients,
  accountFormOf,
  accountsCursorMoved,
  accountsCursorStart,
  atFirstStep,
  draftKey,
  executorsItem,
  initialDraft,
  isFinished,
  loginCommandOf,
  parseAccountLine,
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
}

type Tone = 'ok' | 'warn' | 'error';

type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'prompt';
      readonly purpose: 'executor' | 'budget' | 'account';
      /** The account of the cap (`budget`), or the client of the new account (`account`). */
      readonly profileId: string;
      readonly value: string;
    }
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
};

/** The hints of the bar that make sense at the step on screen. */
function relevantBar(
  item: UiBarItem,
  step: string | undefined,
  finished: boolean,
  accounts: boolean,
): boolean {
  if (finished) return item.id === 'setup.advance';
  if (accounts) {
    return ![
      'setup.toggle',
      'setup.edit',
      'setup.remove',
      'setup.moveUp',
      'setup.moveDown',
    ].includes(item.id);
  }
  switch (item.id) {
    case 'setup.toggle':
      return step === 'detect';
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

  const [state, setState] = useState<State>(FIRST);
  const ref = useRef<State>(FIRST);
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
          command,
        }),
        tone: 'error',
      };
    }
  };

  /** Adds the subscription account and logs in to it at once (N274). */
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
        result.login === 'logged_in'
          ? { text: t('setup.accounts.result.loggedIn', { profile: profileId }), tone: 'ok' }
          : await loginOf(profileId);
    } catch (error) {
      if (!alive.current) return;
      update({
        busy: false,
        message: {
          text: t('setup.accounts.result.failed', { message: errorText(error) }),
          tone: 'error',
        },
      });
      return;
    }
    await refresh(message);
  };

  const submitPrompt = (current: Extract<Mode, { kind: 'prompt' }>, draft: Draft): void => {
    if (current.purpose === 'account') {
      const account = parseAccountLine(current.profileId, current.value);
      if (account === undefined) {
        update({ mode: IDLE });
        say(t('setup.prompt.badAccount', { form: accountFormOf(current.profileId) }), 'warn');
        return;
      }
      void addAccount({
        client: current.profileId,
        name: account.name,
        kind: 'token_plan',
        provider: account.provider,
      });
      return;
    }
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

  /** The keys of the step that adds an account. */
  const onAccountsKey = (run: SetupRunView, name: string): void => {
    const cursor = ref.current.accountsCursor;
    switch (name) {
      case 'advance':
        update({ stage: 'steps' });
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
        if (entry !== undefined) {
          update({
            mode: { kind: 'prompt', purpose: 'account', profileId: entry.client, value: '' },
          });
        }
        return;
      }
      case 'reload':
        void reread(run);
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
        void reread(run);
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
          : mode.purpose === 'account'
            ? t('setup.prompt.account', {
                client: mode.profileId,
                form: accountFormOf(mode.profileId),
              })
            : t('setup.prompt.budget', { profile: mode.profileId }),
      color: TOKEN.accent,
    });
    head.push({ key: 'p.value', text: `> ${mode.value}▏` });
    head.push({ key: 'p.hint', text: t('setup.prompt.hintEnter'), dim: true });
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
  } else if (state.busy) {
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
          accounts: accountsOn
            ? {
                active: onAccounts,
                cursor: state.accountsCursor,
                added: state.added,
                addKey: keyLabel(keymap, 'setup.add') ?? '',
                nextKey: keyLabel(keymap, 'setup.advance') ?? '',
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

  const bar = deriveShortcutBar(keymap.registry, keymap.keymap, ['setup']).filter((item) =>
    relevantBar(item, run?.step, finished, onAccounts),
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
