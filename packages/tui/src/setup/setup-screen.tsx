// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError, deriveShortcutBar, type UiBarItem } from '@otheater/client';
import type {
  AddProfileBody,
  SetupAdapterClient,
  SetupModels,
  SetupPlan,
  SetupRolePlacement,
  SetupRunView,
} from '@otheater/protocol';
import { Box, useWindowSize } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../layout/themed-text.js';
import { keyLabel } from '../keys/labels.js';
import { useRawKeys, type KeyEvent, type TuiKeymap } from '../keys/use-keymap.js';
import { Frame } from '../layout/frame.js';
import { ShortcutBar } from '../layout/shortcut-bar.js';
import { fit, sliceCells, wrapText } from '../layout/text.js';
import { TOKEN, paint } from '../layout/theme.js';
import { useSuspendTerminal } from '../mouse/index.js';
import { useRenderControl } from '../render-control.js';
import { fieldStep } from '../tabs/settings/field.js';
import { errorText, runInTerminal } from '../tabs/settings/index.js';
import type {
  SetupExecutorsInputMode,
  SetupExecutorsLayoutMode,
  SetupModelPickMode,
  SetupReviewNotesMode,
} from '../settings.js';
import type { SetupApi, SetupFlow } from './api.js';
import {
  accountFormKey,
  accountFormLines,
  accountFormStart,
  unknownClientText,
  type AccountForm,
} from './account-form.js';
import {
  effortOfPick,
  effortPickKey,
  effortPickLines,
  effortPickStart,
  type EffortPick,
} from './effort-pick.js';
import {
  accountsOfRun,
  discoveredOfRun,
  listOf,
  presetRowRoles,
  rowOfExecutor,
  rowRoles,
  seededRows,
  type ModelsRead,
} from './executor-list.js';
import { clientStateText, clientTodoText, setupLines, type SetupLine } from './lines.js';
import {
  choiceOf,
  modelPickKey,
  modelPickLines,
  modelPickStart,
  seedOfChoices,
  type ModelChoice,
  type ModelPick,
} from './model-pick.js';
import { rolePickKey, rolePickLines, rolePickStart, type RolePick } from './role-pick.js';
import {
  accountClients,
  accountsCursorMoved,
  accountsCursorStart,
  adapterToInstall,
  atFirstStep,
  columnMoved,
  columnOf,
  draftKey,
  effortMoved,
  executorsItem,
  initialDraft,
  isFinished,
  isTable,
  loginCommandOf,
  parseBudgetLine,
  parseExecutorLine,
  planRolesOf,
  reconciledDraft,
  reordered,
  reviewExecutors,
  reviewStart,
  stepNumber,
  submissionOf,
  tableRowUnderCursor,
  toggled,
  withBudget,
  withCursor,
  withExecutor,
  withList,
  withoutExecutor,
  withRowEffort,
  withRowRoles,
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
  /** `ui.setup.modelPick` (N324): which models the list after a login starts checked; `preset`. */
  readonly modelPick?: SetupModelPickMode | undefined;
  /**
   * `ui.setup.executorsInput` (N333) [proposta]: `list` shows, per account, the models the client
   * catalog lists, to check; `prompt` keeps the typed line `<account> <model> [effort]` only.
   */
  readonly executorsInput?: SetupExecutorsInputMode | undefined;
  /**
   * `ui.setup.executorsLayout` (N335) [proposta]: `table` draws the models as a table with the
   * effort and the roles of each one to edit; `list` keeps the one-line rows of N333. `table` by default.
   */
  readonly executorsLayout?: SetupExecutorsLayoutMode | undefined;
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
  /** The list of models after a login (N324, item 2). */
  | { readonly kind: 'models'; readonly pick: ModelPick }
  /** The roles of an Executor: of a row of the table, or of an Executor of the plan in the review (N333, N335). */
  | { readonly kind: 'roles'; readonly pick: RolePick }
  /** The efforts a model of the table accepts (N335). */
  | { readonly kind: 'effort'; readonly pick: EffortPick }
  /** The client says the account is not logged in after the login (N324): L again, S goes on. */
  | { readonly kind: 'loginCheck'; readonly profileId: string }
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
  /** What the list of models after each login chose, by account (N324), for the Executors step. */
  readonly choices: Readonly<Record<string, ModelChoice>>;
  /**
   * The plan the review showed when Enter confirmed it (2026-11-26) [proposta]: the finished screen
   * repeats its summary. The daemon's result keeps only the keys and the Executors written.
   */
  readonly confirmedPlan: SetupPlan | undefined;
  /** The Executor of the plan the cursor of the review is on (N333; N335: any of them). */
  readonly reviewCursor: number;
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
  choices: {},
  confirmedPlan: undefined,
  reviewCursor: 0,
};

/** An account exists already: added in this run, or found by the detection. */
function accountExists(run: SetupRunView, added: readonly string[]): boolean {
  return added.length > 0 || (run.prompt?.step === 'detect' && run.prompt.profiles.length > 0);
}

/** The bar while the form is open: its own keys, fixed as the form reads them (N326). */
const FORM_BAR: readonly UiBarItem[] = [
  { id: 'accountForm.submit', label: 'Enter', text: { key: 'bar.accountForm.submit' } },
  { id: 'accountForm.next', label: 'Tab', text: { key: 'bar.accountForm.next' } },
  { id: 'accountForm.change', label: 'Space', text: { key: 'bar.accountForm.change' } },
  { id: 'accountForm.cancel', label: 'Esc', text: { key: 'bar.accountForm.cancel' } },
];

/** The bar while the list of models after a login is open (N324): its own keys. */
const MODELS_BAR: readonly UiBarItem[] = [
  { id: 'modelPick.confirm', label: 'Enter', text: { key: 'bar.modelPick.confirm' } },
  { id: 'modelPick.toggle', label: 'Space', text: { key: 'bar.modelPick.toggle' } },
  { id: 'modelPick.cancel', label: 'Esc', text: { key: 'bar.modelPick.cancel' } },
];

/** The bar while the roles of an Executor are chosen at the review (N333): its own keys. */
const ROLES_BAR: readonly UiBarItem[] = [
  { id: 'rolePick.confirm', label: 'Enter', text: { key: 'bar.rolePick.confirm' } },
  { id: 'rolePick.toggle', label: 'Space', text: { key: 'bar.rolePick.toggle' } },
  { id: 'rolePick.cancel', label: 'Esc', text: { key: 'bar.rolePick.cancel' } },
];

/** The bar while the effort of a model of the table is chosen (N335): its own keys. */
const EFFORT_BAR: readonly UiBarItem[] = [
  { id: 'effortPick.confirm', label: 'Enter', text: { key: 'bar.effortPick.confirm' } },
  { id: 'effortPick.cancel', label: 'Esc', text: { key: 'bar.effortPick.cancel' } },
];

/** The bar while the account is not logged in after the login (N324). */
const LOGIN_CHECK_BAR: readonly UiBarItem[] = [
  { id: 'loginCheck.retry', label: 'L', text: { key: 'bar.loginCheck.retry' } },
  { id: 'loginCheck.skip', label: 'S', text: { key: 'bar.loginCheck.skip' } },
];

/** What the bar needs to know of the screen to pick the hints that make sense at the step. */
interface BarContext {
  readonly step: string | undefined;
  readonly finished: boolean;
  /** The step that adds an account is on screen. */
  readonly accounts: boolean;
  readonly hasAccount: boolean;
  /** The list of models (N333) has rows on screen. */
  readonly list: boolean;
  /** The review has Executors to give roles to (N333; N335: any Executor of the plan). */
  readonly reviewable: boolean;
  /** The table of the Executors (N335) is on screen, and the cursor is on one of its rows. */
  readonly onRow: boolean;
}

function relevantBar(item: UiBarItem, ctx: BarContext): boolean {
  const { step } = ctx;
  if (ctx.finished) return item.id === 'setup.advance';
  if (ctx.accounts) {
    // N326: S continues without an account only where there is none yet.
    if (item.id === 'setup.skip') return !ctx.hasAccount;
    return ![
      'setup.toggle',
      'setup.edit',
      'setup.remove',
      'setup.moveUp',
      'setup.moveDown',
      'setup.details',
      'setup.effortNext',
      'setup.type',
      'setup.role',
    ].includes(item.id);
  }
  switch (item.id) {
    case 'setup.install':
    case 'setup.skip':
      return false;
    case 'setup.toggle':
      // N335: on a row of the table Space edits the cell, like Enter (one hint says it).
      return step === 'detect' || (step === 'executors' && ctx.list && !ctx.onRow);
    case 'setup.details':
      return step === 'review';
    case 'setup.add':
      // N333: with the list on screen, typing a line is the `/` key.
      return step === 'executors' && !ctx.list;
    case 'setup.edit':
      return step === 'executors';
    case 'setup.effortNext':
    case 'setup.type':
      return step === 'executors' && ctx.list;
    case 'setup.role':
      return step === 'review' && ctx.reviewable;
    default:
      return true;
  }
}

/** The words of a hint of the bar for the screen it is on (N326: the form; N335: the table). */
function barText(item: UiBarItem, ctx: BarContext, openForm: boolean): UiBarItem {
  // N326: with no account yet, Enter at the step opens the form instead of going on.
  if (openForm && item.id === 'setup.advance')
    return { ...item, text: { key: 'bar.setup.openForm' } };
  if (ctx.onRow && item.id === 'setup.advance') return { ...item, text: { key: 'bar.setup.cell' } };
  if (ctx.onRow && item.id === 'setup.effortNext') {
    return { ...item, text: { key: 'bar.setup.column' } };
  }
  return item;
}

export function SetupScreen(props: SetupScreenProps): ReactNode {
  const { flow, api, keymap, onClose } = props;
  const { t } = useTranslation();
  const { columns, rows } = useWindowSize();
  const { afterKey } = useRenderControl();
  const suspendTerminal = useSuspendTerminal();
  // The step that adds an account exists in the first run, when the API has the routes for it.
  const accountsOn = flow === 'first_run' && api.accounts !== undefined;
  // N333: the step of the Executors lists the models (`ui.setup.executorsInput`) and the API can read them.
  const listing = props.executorsInput !== 'prompt' && api.accounts?.models !== undefined;

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

  /**
   * Shows the view the daemon gave: the draft is the one remembered for the step, or a fresh one.
   * `keep`: the draft on screen counts as remembered when it is of the same step (the list of
   * accounts was read again, and the marks the person made stay). A remembered draft of the
   * detection takes in the accounts the daemon lists now ({@link reconciledDraft}).
   */
  const show = (run: SetupRunView, message?: State['message'], keep = false): void => {
    const current = ref.current;
    const onScreen =
      keep && current.run !== undefined && draftKey(current.run) === draftKey(run)
        ? current.draft
        : undefined;
    const remembered = memory.current.get(draftKey(run)) ?? onScreen;
    // N324: the step of the Executors opens with what the lists of models after the logins chose.
    const fresh = initialDraft(run.prompt, seedOfChoices(run, ref.current.choices));
    const draft =
      remembered?.kind === fresh.kind
        ? reconciledDraft(remembered, run.prompt, current.added)
        : fresh;
    update({
      load: 'ready',
      loadError: undefined,
      run,
      draft,
      mode: IDLE,
      busy: false,
      message,
      reviewCursor: run.prompt?.step === 'review' ? reviewStart(run.prompt.plan) : 0,
    });
    // N333: the step of the Executors lists the models of each account, once per draft.
    if (draft.kind === 'executors' && draft.list === undefined && listing) void loadList(run);
  };

  /**
   * Reads the models of each account of the run and puts them in the draft of the Executors as rows
   * (N333). What the lists after the logins chose (N324) is merged in: a model checked there is
   * checked here, a preset Executor unchecked there is unchecked here. A read that fails leaves its
   * account without rows and says so; the typed line is still there (`/`).
   */
  const loadList = async (run: SetupRunView): Promise<void> => {
    const models = api.accounts?.models;
    const start = ref.current.draft;
    if (models === undefined || start.kind !== 'executors') return;
    update({ draft: { ...start, list: 'loading' } });
    const reads: ModelsRead[] = await Promise.all(
      accountsOfRun(run.done).map(async (profileId): Promise<ModelsRead> => {
        try {
          return { profileId, found: await models(profileId) };
        } catch (error) {
          return { profileId, failure: errorText(error) };
        }
      }),
    );
    if (!alive.current) return;
    const now = ref.current;
    // The person went elsewhere meanwhile: the read belongs to a step that is not on screen.
    if (now.run === undefined || draftKey(now.run) !== draftKey(run)) return;
    if (now.draft.kind !== 'executors') return;
    const { rows, groups } = listOf(reads, discoveredOfRun(run.done));
    const seeded = seededRows(rows, now.draft.executors, now.draft.exclude ?? []);
    update({
      draft: withList(now.draft, {
        rows: seeded.rows,
        groups,
        executors: seeded.executors,
        exclude: seeded.exclude,
        layout: props.executorsLayout ?? 'table',
      }),
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
      if (run.prompt?.step === 'review') update({ confirmedPlan: run.prompt.plan });
      void command(run, () => api.confirm(run.id));
      return;
    }
    if (draft.kind === 'executors' && draft.list === 'loading') {
      say(t('setup.executors.waitList'), 'warn');
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

  /**
   * Shows the run as the daemon holds it now (the accounts it lists changed), with a message. A
   * read that fails keeps what is on screen and says so, with the key that reads again (the owner
   * on 2026-11-26): the account was added all the same. `false` when the run was not read.
   */
  const refresh = async (message?: State['message']): Promise<boolean> => {
    let failure: string | undefined;
    try {
      const overview = await api.overview();
      const active = overview.flows.find((entry) => entry.flow === flow)?.active ?? null;
      if (!alive.current) return false;
      if (active !== null) {
        show(active, message, true);
        return true;
      }
    } catch (error) {
      failure = errorText(error);
    }
    if (!alive.current) return false;
    if (failure === undefined) {
      update({ busy: false, message });
      return false;
    }
    const warning = t('setup.accounts.rereadFailed', {
      message: failure,
      reload: keyLabel(keymap, 'setup.reload') ?? '',
    });
    update({
      busy: false,
      message: {
        text: message === undefined ? warning : `${message.text} ${warning}`,
        tone: message?.tone === 'error' ? 'error' : 'warn',
      },
    });
    return false;
  };

  /**
   * Leaves the step that adds an account for the steps of the run (Enter or S; the owner on
   * 2026-11-26, "Reler e marcar"): the list of accounts is read again first, so the accounts added
   * here are in the detection, checked. A read that fails goes on with what is on screen, and says so.
   */
  const toSteps = async (skipped: boolean): Promise<void> => {
    update({ busy: true, message: undefined });
    const read = await refresh();
    if (!alive.current) return;
    update({ stage: 'steps' });
    if (read && skipped) say(t('setup.accounts.skipped'), 'warn');
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
      if (body.kind === 'api') {
        message = { text: t('setup.accounts.result.added', { profile: profileId }), tone: 'ok' };
      } else {
        const loggedIn =
          result.login === 'logged_in'
            ? {
                text: t('setup.accounts.result.loggedIn', { profile: profileId }),
                tone: 'ok' as const,
              }
            : await loginOf(profileId);
        await afterLogin(profileId, loggedIn);
        return;
      }
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

  /**
   * After the login of a subscription (N324, item 2): asks the client whether the account is logged
   * in, then opens the list of the models its client lists. Not logged in: L logs in again, S goes
   * on without it. No list to choose from (no catalog, or every model registered already): the
   * step goes on, and the daemon's default stands.
   */
  const afterLogin = async (
    profileId: string,
    message: NonNullable<State['message']>,
  ): Promise<void> => {
    const models = api.accounts?.models;
    if (models === undefined) {
      await refresh(message);
      return;
    }
    update({ busy: true });
    let found: SetupModels;
    try {
      found = await models(profileId);
    } catch (error) {
      if (!alive.current) return;
      await refresh({
        text: t('setup.models.failed', { profile: profileId, message: errorText(error) }),
        tone: 'warn',
      });
      return;
    }
    if (!alive.current) return;
    if (found.login === 'logged_out') {
      update({
        busy: false,
        mode: { kind: 'loginCheck', profileId },
        message: { text: t('setup.models.loggedOut', { profile: profileId }), tone: 'warn' },
      });
      return;
    }
    const pick = modelPickStart(found, props.modelPick ?? 'preset');
    if (pick === undefined) {
      await refresh(
        found.catalog === 'unavailable'
          ? {
              text: t('setup.models.unavailable', {
                profile: profileId,
                reason: found.reason ?? '',
              }),
              tone: 'warn',
            }
          : message,
      );
      return;
    }
    update({ busy: false, mode: { kind: 'models', pick }, message });
  };

  /** The keys while the account is not logged in after its login (N324): L again, S or Esc go on. */
  const onLoginCheckKey = (profileId: string, combo: string | undefined): void => {
    const key = (combo ?? '').toUpperCase();
    if (key === 'L') {
      update({ busy: true, mode: IDLE, message: undefined });
      void (async () => {
        const message = await loginOf(profileId);
        if (alive.current) await afterLogin(profileId, message);
      })();
      return;
    }
    if (key === 'S' || combo === 'Esc') {
      update({ busy: true, mode: IDLE });
      void refresh({ text: t('setup.models.noLogin', { profile: profileId }), tone: 'warn' });
    }
  };

  /** The keys of the list of models (N324): Enter keeps the choice for the step of the Executors. */
  const onModelsKey = (pick: ModelPick, combo: string | undefined): void => {
    const step = modelPickKey(pick, combo);
    if (step.done === undefined) {
      update({ mode: { kind: 'models', pick: step.pick } });
      return;
    }
    const others = Object.fromEntries(
      Object.entries(ref.current.choices).filter(([profileId]) => profileId !== pick.profileId),
    );
    if (step.done === 'confirm') {
      const choice = choiceOf(step.pick);
      update({ busy: true, mode: IDLE, choices: { ...others, [pick.profileId]: choice } });
      void refresh({
        text: t('setup.models.chosen', {
          profile: pick.profileId,
          count: choice.checked.length,
        }),
        tone: 'ok',
      });
      return;
    }
    update({ busy: true, mode: IDLE, choices: others });
    void refresh({ text: t('setup.models.skipped', { profile: pick.profileId }), tone: 'warn' });
  };

  /**
   * Sets the roles of an Executor of the plan (N333, item 4; N335) [proposta]: the review goes back
   * to the step of the Executors and answers it again with the same input and an `exact` placement
   * for the Executor, which then is in exactly those roles (it leaves the others, enters the new
   * ones at the end). An earlier placement of the same Executor (by id, or by `request`) is
   * replaced. A refusal leaves the run at the step of the Executors, and says why.
   */
  const assignRoles = async (
    run: SetupRunView,
    executorId: string,
    roles: RolePick['checked'],
  ): Promise<void> => {
    const answered = run.done.find((entry) => entry.step === 'executors');
    if (answered === undefined) return;
    const previous = answered.input;
    const planned = answered.output.executors.map((executor) => executor.id);
    const placed = (place: SetupRolePlacement): string | undefined =>
      place.executorId ?? (place.request === undefined ? undefined : planned[place.request]);
    const others = previous.roles.filter((place) => placed(place) !== executorId);
    const placements: SetupRolePlacement[] = [
      ...others,
      { executorId, mode: 'exact', roles: [...roles] },
    ];
    update({ busy: true, mode: IDLE, message: undefined });
    let at: SetupRunView = run;
    try {
      at = await api.back(run.id);
      const next = await api.submit(at.id, {
        step: 'executors',
        input: {
          executors: previous.executors,
          budgets: previous.budgets,
          exclude: previous.exclude,
          roles: placements,
        },
      });
      if (!alive.current) return;
      remember(`${run.id}/executors`, run, executorId, roles, planned);
      show(next, {
        text: t('setup.review.rolesGiven', {
          executor: executorId,
          roles: roles.length === 0 ? t('setup.review.noRole') : roles.join(', '),
        }),
        tone: 'ok',
      });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiRequestError && error.code === 'conflict') {
        await reread(run, {
          text: t('setup.refused', { message: errorText(error) }),
          tone: 'error',
        });
        return;
      }
      if (at !== run)
        show(at, { text: t('setup.refused', { message: errorText(error) }), tone: 'error' });
      else refused(error);
    }
  };

  /**
   * Keeps the roles given at the review in the draft remembered for the step of the Executors, so
   * going back to it shows them: in the row of the model that gives the Executor (N335), or, for an
   * Executor that is not a row, as a placement the step repeats when it is answered again.
   */
  const remember = (
    key: string,
    run: SetupRunView,
    executorId: string,
    roles: RolePick['checked'],
    planned: readonly string[],
  ): void => {
    const kept = memory.current.get(key);
    if (kept?.kind !== 'executors') return;
    const others = (kept.placements ?? []).filter((place) => place.executorId !== executorId);
    const at = kept.rows === undefined ? undefined : rowOfExecutor(kept.rows, planned, executorId);
    const row = at === undefined ? undefined : kept.rows?.[at];
    if (at !== undefined && row !== undefined) {
      const next = withRowRoles(kept, at, roles, presetRowRoles(run, row));
      memory.current.set(
        key,
        next.kind === 'executors' && others.length > 0 ? { ...next, placements: others } : next,
      );
      return;
    }
    memory.current.set(key, {
      ...kept,
      placements: [...others, { executorId, mode: 'exact', roles: [...roles] }],
    });
  };

  /** The keys of the list of roles (N333; N335): of a row of the table, or of an Executor of the review. */
  const onRolesKey = (run: SetupRunView, pick: RolePick, combo: string | undefined): void => {
    const step = rolePickKey(pick, combo);
    if (step.done === undefined) {
      update({ mode: { kind: 'roles', pick: step.pick } });
      return;
    }
    if (step.done === 'cancel') {
      update({ mode: IDLE });
      return;
    }
    const { target } = step.pick;
    if (target.kind === 'review') {
      void assignRoles(run, target.executorId, step.pick.checked);
      return;
    }
    const draft = ref.current.draft;
    const row = draft.kind === 'executors' ? draft.rows?.[target.index] : undefined;
    if (row === undefined) {
      update({ mode: IDLE });
      return;
    }
    update({
      mode: IDLE,
      draft: withRowRoles(draft, target.index, step.pick.checked, presetRowRoles(run, row)),
    });
  };

  /** The keys of the list of efforts of a row of the table (N335): Enter chooses, Esc leaves it. */
  const onEffortKey = (pick: EffortPick, combo: string | undefined): void => {
    const step = effortPickKey(pick, combo);
    if (step.done === undefined) {
      update({ mode: { kind: 'effort', pick: step.pick } });
      return;
    }
    if (step.done === 'cancel') {
      update({ mode: IDLE });
      return;
    }
    update({
      mode: IDLE,
      draft: withRowEffort(ref.current.draft, step.pick.row, effortOfPick(step.pick)),
    });
  };

  /**
   * Edits the cell of the table under the cursor (Space or Enter; N335): the mark flips, the effort
   * and the roles open their lists. A row that is already an Executor of the account has nothing to
   * edit, and the roles of a row that is not checked have no Executor to belong to yet.
   */
  const editCell = (run: SetupRunView, draft: Draft): void => {
    if (draft.kind !== 'executors') return;
    const index = tableRowUnderCursor(draft);
    const row = index === undefined ? undefined : draft.rows?.[index];
    if (index === undefined || row === undefined) {
      say(t('setup.executors.registeredRow'), 'warn');
      return;
    }
    switch (columnOf(draft)) {
      case 'mark':
        update({ draft: toggled(draft) });
        return;
      case 'effort': {
        const pick = effortPickStart(draft.rows ?? [], index);
        if (pick === undefined) say(t('setup.executors.noEffort'), 'warn');
        else update({ mode: { kind: 'effort', pick } });
        return;
      }
      case 'roles':
        if (!row.on) say(t('setup.executors.needsMark'), 'warn');
        else {
          const pick = rolePickStart({ kind: 'row', index }, row.model, rowRoles(run, row));
          update({ mode: { kind: 'roles', pick } });
        }
        return;
    }
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
        if (hasAccount(run)) void toSteps(false);
        else openForm(run, accountClients(run.prompt)[cursor]?.client);
        return;
      case 'skip':
        void toSteps(!hasAccount(run));
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
    if (mode.kind === 'models') {
      onModelsKey(mode.pick, event.combo);
      return;
    }
    if (mode.kind === 'loginCheck') {
      onLoginCheckKey(mode.profileId, event.combo);
      return;
    }
    if (mode.kind === 'roles') {
      onRolesKey(run, mode.pick, event.combo);
      return;
    }
    if (mode.kind === 'effort') {
      onEffortKey(mode.pick, event.combo);
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
        // N335: on a row of the table Enter edits the cell; the last item ("Continuar") goes on.
        if (
          !isFinished(run) &&
          executorsItem(draft, run.prompt)?.kind === 'row' &&
          isTable(draft)
        ) {
          editCell(run, draft);
          return;
        }
        advance(run, draft);
        return;
      case 'back':
        back(run);
        return;
      case 'itemPrev':
      case 'itemNext': {
        const delta = action === 'setup.itemPrev' ? -1 : 1;
        if (run.step === 'review' && run.prompt?.step === 'review') {
          // N333, N335: the cursor of the review walks the Executors of the plan.
          const last = Math.max(0, reviewExecutors(run.prompt.plan).length - 1);
          update({ reviewCursor: Math.min(last, Math.max(0, current.reviewCursor + delta)) });
          return;
        }
        update({ draft: withCursor(draft, run.prompt, delta) });
        return;
      }
      case 'toggle':
        if (isTable(draft) && executorsItem(draft, run.prompt)?.kind === 'row') {
          editCell(run, draft);
          return;
        }
        update({ draft: toggled(draft) });
        return;
      case 'effortPrev':
      case 'effortNext': {
        const delta = action === 'setup.effortPrev' ? -1 : 1;
        // N335: in the table ←/→ walk the cells that can be edited; in the list they move the effort.
        update({ draft: isTable(draft) ? columnMoved(draft, delta) : effortMoved(draft, delta) });
        return;
      }
      case 'type':
        if (draft.kind === 'executors') {
          update({ mode: { kind: 'prompt', purpose: 'executor', profileId: '', value: '' } });
        }
        return;
      case 'role': {
        if (run.step !== 'review' || run.prompt?.step !== 'review' || isFinished(run)) return;
        const plan = run.prompt.plan;
        const id = reviewExecutors(plan)[current.reviewCursor];
        if (id === undefined) say(t('setup.review.noRoleNone'), 'warn');
        else {
          const pick = rolePickStart({ kind: 'review', executorId: id }, id, planRolesOf(plan, id));
          update({ mode: { kind: 'roles', pick } });
        }
        return;
      }
      case 'moveUp':
        update({ draft: reordered(draft, -1) });
        return;
      case 'moveDown':
        update({ draft: reordered(draft, 1) });
        return;
      case 'add':
        if (draft.kind !== 'executors') return;
        // N333: with the list on screen, a typed line is the `/` key.
        if ((draft.rows?.length ?? 0) > 0) say(t('setup.executors.useType'), 'warn');
        else update({ mode: { kind: 'prompt', purpose: 'executor', profileId: '', value: '' } });
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
  } else if (mode.kind === 'models') {
    for (const line of modelPickLines(mode.pick, t)) {
      head.push({
        key: line.key,
        text: line.text,
        ...(line.tone === 'accent' ? { color: TOKEN.accent } : {}),
        ...(line.dim === true ? { dim: true } : {}),
        ...(line.selected === true ? { selected: true } : {}),
      });
    }
    head.push({ key: 'mp.gap', text: '' });
  } else if (mode.kind === 'roles') {
    for (const line of rolePickLines(mode.pick, t)) {
      head.push({
        key: line.key,
        text: line.text,
        ...(line.tone === 'accent' ? { color: TOKEN.accent } : {}),
        ...(line.dim === true ? { dim: true } : {}),
        ...(line.selected === true ? { selected: true } : {}),
      });
    }
    head.push({ key: 'rp.gap', text: '' });
  } else if (mode.kind === 'effort') {
    for (const line of effortPickLines(mode.pick, t)) {
      head.push({
        key: line.key,
        text: line.text,
        ...(line.tone === 'accent' ? { color: TOKEN.accent } : {}),
        ...(line.dim === true ? { dim: true } : {}),
        ...(line.selected === true ? { selected: true } : {}),
      });
    }
    head.push({ key: 'ep.gap', text: '' });
  } else if (mode.kind === 'loginCheck') {
    head.push({ key: 'lc.hint', text: t('setup.models.loginCheckKeys'), dim: true });
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
          width: innerWidth - 1,
          reviewNotes: { all: state.details, key: keyLabel(keymap, 'setup.details') ?? '' },
          confirmedPlan: state.confirmedPlan,
          reviewRoles:
            run.step === 'review' && !finished
              ? { cursor: state.reviewCursor, key: keyLabel(keymap, 'setup.role') ?? '' }
              : undefined,
          accounts: accountsOn
            ? {
                active: onAccounts,
                // While the form is open, its field holds the cursor.
                cursor: mode.kind === 'form' || mode.kind === 'models' ? -1 : state.accountsCursor,
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
    const indent = ' '.repeat(line.indent ?? 0);
    // N335: a row of the table is already cut to the width; wrapping would collapse its spaces.
    const pieces =
      line.raw === true
        ? [indent + line.text]
        : wrapText(line.text, Math.max(1, innerWidth - 1 - indent.length)).map(
            (piece) => indent + piece,
          );
    pieces.forEach((piece, index) => {
      const full = fit(`${line.selected === true && index === 0 ? '›' : ' '}${piece}`, innerWidth);
      // The cell the keys act on is drawn as the caret (N335); the one column of the `›` comes first.
      const focus = index === 0 ? line.focus : undefined;
      wrapped.push(
        <Text
          key={`${line.key}.${String(index)}`}
          wrap="truncate"
          dimColor={line.dim === true}
          bold={line.bold === true}
          {...paint(line.color, line.selected === true ? TOKEN.selected : undefined)}
        >
          {focus === undefined ? (
            full
          ) : (
            <>
              {sliceCells(full, 0, focus[0] + 1)}
              <Text caret>{sliceCells(full, focus[0] + 1, focus[1] + 1)}</Text>
              {sliceCells(full, focus[1] + 1, innerWidth)}
            </>
          )}
        </Text>,
      );
    });
  }
  const first = Math.max(0, cursorLine - Math.max(1, innerHeight - 1));

  const hasAccountNow = run !== undefined && accountExists(run, state.added);
  const barContext: BarContext = {
    step: run?.step,
    finished,
    accounts: onAccounts,
    hasAccount: hasAccountNow,
    list: draft.kind === 'executors' && (draft.rows?.length ?? 0) > 0,
    reviewable: run?.prompt?.step === 'review' && reviewExecutors(run.prompt.plan).length > 0,
    onRow: run !== undefined && isTable(draft) && executorsItem(draft, run.prompt)?.kind === 'row',
  };
  const bar =
    mode.kind === 'form'
      ? FORM_BAR
      : mode.kind === 'models'
        ? MODELS_BAR
        : mode.kind === 'roles'
          ? ROLES_BAR
          : mode.kind === 'effort'
            ? EFFORT_BAR
            : mode.kind === 'loginCheck'
              ? LOGIN_CHECK_BAR
              : deriveShortcutBar(keymap.registry, keymap.keymap, ['setup'])
                  .filter((item) => relevantBar(item, barContext))
                  .map((item) => barText(item, barContext, onAccounts && !hasAccountNow));

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
