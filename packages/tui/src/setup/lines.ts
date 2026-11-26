// SPDX-License-Identifier: MPL-2.0
import type {
  SetupDetectedClient,
  SetupNote,
  SetupPlan,
  SetupPrompt,
  SetupRunView,
} from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { TOKEN } from '../layout/theme.js';
import { accountClients, stepNumber, type Draft } from './model.js';

/** One row of the setup screen, before it is cut to the width. */
export interface SetupLine {
  readonly key: string;
  readonly text: string;
  readonly color?: string | undefined;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /** The row under the cursor. */
  readonly selected?: boolean;
}

export interface SetupLinesInput {
  readonly run: SetupRunView;
  readonly draft: Draft;
  readonly t: TFunction;
  /** The label of the key that closes the finished screen (the `advance` key). */
  readonly closeKey: string;
  /** The step that adds an account (N274): present only when the screen has it in this run. */
  readonly accounts?: AccountsStage | undefined;
  /** How the review draws its notes (N324); folded with no key label when absent. */
  readonly reviewNotes?: ReviewNotesView | undefined;
}

/** How the review draws its notes (N324, `ui.setup.reviewNotes`). */
export interface ReviewNotesView {
  /** Every note on its own line; otherwise the notes of one kind are folded. */
  readonly all: boolean;
  /** The label of the key that flips it. */
  readonly key: string;
}

/** The step before the detection that adds an account; it is not a step of the daemon's run. */
export interface AccountsStage {
  /** It is the step on screen (otherwise it is behind the person: done). */
  readonly active: boolean;
  readonly cursor: number;
  /** The accounts added in this run, in order. */
  readonly added: readonly string[];
  /** The labels of the keys that add an account and that continue. */
  readonly addKey: string;
  readonly nextKey: string;
  /** The label of the key that continues without an account (N326); default none. */
  readonly skipKey?: string | undefined;
  /** An account exists already (added in this run or found): Enter continues; otherwise it adds. */
  readonly hasAccount?: boolean | undefined;
  /** The labels of the keys that install an adapter and that look again (P18b); default none. */
  readonly installKey?: string | undefined;
  readonly reloadKey?: string | undefined;
  /** The install of the adapter of this client is running (P18b), and for how many seconds. */
  readonly installing?: { readonly client: string; readonly seconds: number } | undefined;
}

/**
 * Why a client is or is not on this machine, short (P18, N321): the reason the daemon gave, or
 * only installed / not found when it gave none (an old daemon).
 */
export function clientStateText(entry: SetupDetectedClient, t: TFunction): string {
  if (entry.reason !== undefined) return t(`setup.reason.${entry.reason}`);
  return t(entry.installed ? 'setup.reason.installed' : 'setup.reason.not_found');
}

/**
 * What the person can do about a client that is not there (P18b): install its adapter (I), or
 * install the program and look again (R). Never an `ot` command: the assistant is the way.
 */
export function clientTodoText(
  entry: SetupDetectedClient,
  keys: { readonly install: string; readonly reload: string },
  t: TFunction,
): string | undefined {
  if (entry.installed) return undefined;
  switch (entry.reason) {
    case 'adapter_missing':
      return t('setup.todo.adapter_missing', { client: entry.client, key: keys.install });
    case 'managed_pending':
      return t('setup.todo.managed_pending', { key: keys.reload });
    case 'disabled':
      return t('setup.todo.disabled', { client: entry.client });
    default:
      return t('setup.todo.not_found', { client: entry.client, key: keys.reload });
  }
}

const MARK = { done: '✓', now: '●', todo: '○' } as const;

/** `✓ Accounts  ● Preset  ○ Executors  ○ Review`, with `New account` ahead when the screen has that step. */
function progress(run: SetupRunView, t: TFunction, accounts: AccountsStage | undefined): string {
  const now = accounts?.active === true ? -1 : stepNumber(run) - 1;
  const marks = run.steps.map((step, index) => {
    const mark =
      run.state === 'confirmed' || index < now ? MARK.done : index === now ? MARK.now : MARK.todo;
    return `${mark} ${t(`setup.step.${step}`)}`;
  });
  if (accounts !== undefined) {
    const lead = accounts.active ? MARK.now : MARK.done;
    marks.unshift(`${lead} ${t('setup.step.accounts')}`);
  }
  return marks.join('  ');
}

/** The step that adds an account: the clients with a cursor, what was added, and the keys. */
function accountsStageLines(run: SetupRunView, stage: AccountsStage, t: TFunction): SetupLine[] {
  const lines: SetupLine[] = [
    { key: 'h.clients', text: t('setup.accounts.clients'), color: TOKEN.accent, bold: true },
  ];
  const detected = run.prompt?.step === 'detect';
  const keys = { install: stage.installKey ?? '', reload: stage.reloadKey ?? '' };
  accountClients(run.prompt).forEach((entry, index) => {
    const state = detected ? t('setup.accounts.state', { state: clientStateText(entry, t) }) : '';
    lines.push({
      key: `c.${entry.client}`,
      text: t('setup.accounts.row', { client: entry.client, state }),
      color: detected && !entry.installed ? TOKEN.warn : undefined,
      selected: index === stage.cursor,
    });
    const todo = detected && index === stage.cursor ? clientTodoText(entry, keys, t) : undefined;
    if (todo !== undefined)
      lines.push({ key: `c.${entry.client}.todo`, text: `   ${todo}`, dim: true });
  });
  if (stage.installing !== undefined) {
    lines.push({
      key: 'installing',
      text: t('setup.install.running', {
        client: stage.installing.client,
        seconds: String(stage.installing.seconds),
      }),
      color: TOKEN.accent,
    });
  }
  if (stage.added.length > 0) {
    lines.push({ key: 'gap.added', text: '' });
    lines.push({
      key: 'added',
      text: t('setup.accounts.added', { list: stage.added.join(', ') }),
      color: TOKEN.ok,
    });
  }
  lines.push({ key: 'gap.keys', text: '' });
  lines.push({
    key: 'keys',
    text: t(stage.hasAccount === false ? 'setup.accounts.keysEmpty' : 'setup.accounts.keys', {
      add: stage.addKey,
      next: stage.nextKey,
      skip: stage.skipKey ?? '',
    }),
    dim: true,
  });
  return lines;
}

function usdText(value: number | null, t: TFunction): string {
  return value === null ? t('setup.executors.noCap') : t('setup.executors.usd', { value });
}

function list(items: readonly string[], t: TFunction): string {
  return items.length === 0 ? t('setup.review.none') : items.join(', ');
}

function detectLines(
  prompt: Extract<SetupPrompt, { step: 'detect' }>,
  draft: Extract<Draft, { kind: 'detect' }>,
  t: TFunction,
): SetupLine[] {
  const lines: SetupLine[] = [];
  const clients = prompt.clients.map((entry) =>
    t('setup.detect.client', { client: entry.client, state: clientStateText(entry, t) }),
  );
  if (clients.length > 0) {
    lines.push({
      key: 'clients',
      text: t('setup.detect.clients', { list: clients.join(', ') }),
      dim: true,
    });
  }
  if (draft.rows.length === 0) {
    lines.push({ key: 'none', text: t('setup.detect.none'), color: TOKEN.warn });
    return lines;
  }
  let order = 0;
  draft.rows.forEach((row, index) => {
    const profile = prompt.profiles.find((candidate) => candidate.profileId === row.profileId);
    if (row.on) order += 1;
    const parts = [row.profileId];
    if (profile !== undefined) {
      parts.push(profile.kind);
      if (profile.state !== 'active') parts.push(t(`settings.profile.${profile.state}`));
      parts.push(t(profile.usable ? 'setup.detect.usable' : 'setup.detect.unusable'));
    }
    lines.push({
      key: `d.${row.profileId}`,
      text: `${row.on ? '[x]' : '[ ]'} ${row.on ? t('setup.detect.order', { n: order }) : '   '}${parts.join('  ')}`,
      color: profile?.usable === false ? TOKEN.warn : undefined,
      selected: index === draft.cursor,
    });
  });
  return lines;
}

function accountLines(
  prompt: Extract<SetupPrompt, { step: 'account' }>,
  draft: Extract<Draft, { kind: 'account' }>,
  t: TFunction,
): SetupLine[] {
  if (prompt.profiles.length === 0) {
    return [{ key: 'none', text: t('setup.detect.none'), color: TOKEN.warn }];
  }
  return prompt.profiles.map((profile, index) => ({
    key: `a.${profile.profileId}`,
    text: [
      profile.profileId,
      profile.kind,
      t(profile.usable ? 'setup.detect.usable' : 'setup.detect.unusable'),
    ].join('  '),
    color: profile.usable ? undefined : TOKEN.warn,
    selected: index === draft.cursor,
  }));
}

function presetLines(
  prompt: Extract<SetupPrompt, { step: 'preset' }>,
  draft: Extract<Draft, { kind: 'preset' }>,
  t: TFunction,
): SetupLine[] {
  return prompt.options.map((option, index) => ({
    key: `p.${option}`,
    text:
      t(`setup.preset.name.${option}`) +
      (prompt.current === option ? `  (${t('setup.preset.current')})` : ''),
    selected: index === draft.cursor,
  }));
}

function executorsLines(
  prompt: Extract<SetupPrompt, { step: 'executors' }>,
  draft: Extract<Draft, { kind: 'executors' }>,
  t: TFunction,
): SetupLine[] {
  const lines: SetupLine[] = [
    { key: 'h.list', text: t('setup.executors.listTitle'), color: TOKEN.accent, bold: true },
  ];
  if (draft.executors.length === 0) {
    lines.push({ key: 'e.none', text: t('setup.executors.none'), dim: true });
  }
  draft.executors.forEach((executor, index) => {
    lines.push({
      key: `e.${String(index)}`,
      text:
        executor.effort === undefined
          ? t('setup.executors.row', { profile: executor.profileId, model: executor.model })
          : t('setup.executors.rowEffort', {
              profile: executor.profileId,
              model: executor.model,
              effort: executor.effort,
            }),
      selected: index === draft.cursor,
    });
  });
  lines.push({
    key: 'h.budget',
    text: t('setup.executors.budgetTitle'),
    color: TOKEN.accent,
    bold: true,
  });
  if (prompt.apiProfiles.length === 0) {
    lines.push({ key: 'b.none', text: t('setup.executors.noApi'), dim: true });
  }
  prompt.apiProfiles.forEach((profile, index) => {
    const set = draft.budgets[profile.profileId];
    lines.push({
      key: `b.${profile.profileId}`,
      text:
        set === undefined
          ? t('setup.executors.budgetSuggested', {
              profile: profile.profileId,
              daily: usdText(prompt.suggestedBudget.dailyUsd, t),
              monthly: usdText(prompt.suggestedBudget.monthlyUsd, t),
            })
          : t('setup.executors.budgetRow', {
              profile: profile.profileId,
              daily: usdText(set.dailyUsd, t),
              monthly: usdText(set.monthlyUsd, t),
            }),
      selected: draft.executors.length + index === draft.cursor,
    });
  });
  return lines;
}

function planLines(plan: SetupPlan, t: TFunction, view?: ReviewNotesView): SetupLine[] {
  const lines: SetupLine[] = [
    {
      key: 'preset',
      text:
        plan.preset === null
          ? t('setup.review.presetKept')
          : t('setup.review.preset', { preset: plan.preset }),
      bold: true,
    },
    { key: 'h.roles', text: t('setup.review.roles'), color: TOKEN.accent, bold: true },
  ];
  for (const role of plan.roles) {
    lines.push({
      key: `r.${role.role}`,
      text: t('setup.review.role', {
        role: role.role,
        executors:
          role.executors.length === 0 ? t('setup.review.noExecutors') : role.executors.join(', '),
        rule: t(`settings.role.${role.whenExhausted}`),
      }),
    });
  }
  if (plan.executors.length > 0) {
    lines.push({
      key: 'h.exec',
      text: t('setup.review.executors'),
      color: TOKEN.accent,
      bold: true,
    });
    for (const executor of plan.executors) {
      lines.push({
        key: `x.${executor.id}`,
        text: t('setup.review.executor', {
          id: executor.id,
          model: executor.model,
          provider: executor.provider,
          source: t(`setup.source.${executor.source}`),
        }),
      });
    }
  }
  if (plan.budgets.length > 0) {
    lines.push({
      key: 'h.budgets',
      text: t('setup.review.budgets'),
      color: TOKEN.accent,
      bold: true,
    });
    for (const budget of plan.budgets) {
      lines.push({
        key: `b.${budget.profileId}`,
        text: t('setup.review.budget', {
          profile: budget.profileId,
          daily: usdText(budget.dailyUsd, t),
          monthly: usdText(budget.monthlyUsd, t),
        }),
      });
    }
  }
  lines.push({ key: 'h.writes', text: t('setup.review.writes'), color: TOKEN.accent, bold: true });
  lines.push({ key: 'writes', text: list(plan.writes, t), dim: true });
  if (plan.notes.length > 0) {
    lines.push({ key: 'h.notes', text: t('setup.review.notes'), color: TOKEN.accent, bold: true });
    lines.push(...notesLines(plan.notes, t, view));
  }
  return lines;
}

/**
 * The family of a head of the preset, for the folded review (N324): what comes before the first `-`
 * (`claude-opus-high` → `claude`, `codex-sol-high` → `codex`). [proposta] The family, and not the
 * client, because a head of the preset names a model and no client.
 */
export function familyOf(head: string): string {
  return head.split('-')[0] ?? head;
}

function noteLine(note: SetupNote, key: string, t: TFunction): SetupLine {
  return {
    key,
    text: `[${t(`setup.review.${note.severity}`)}] ${note.message}`,
    color: note.severity === 'warning' ? TOKEN.warn : undefined,
    dim: note.severity === 'info',
  };
}

/**
 * The notes of the review (N324). Folded: the notes that say no account has a model of the preset
 * become one line per family of models, and the roles left with no Executor one line; the other notes
 * stay as they are, and a hint names the key that shows each note. `all`: one line per note.
 */
function notesLines(
  notes: readonly SetupNote[],
  t: TFunction,
  view: ReviewNotesView | undefined,
): SetupLine[] {
  const families = new Map<string, { heads: string[]; roles: Set<string> }>();
  const empty: string[] = [];
  const rest: SetupNote[] = [];
  for (const note of notes) {
    if (note.code === 'no_account' && note.head !== undefined) {
      const family = familyOf(note.head);
      const entry = families.get(family) ?? { heads: [], roles: new Set<string>() };
      if (!entry.heads.includes(note.head)) entry.heads.push(note.head);
      if (note.role !== null) entry.roles.add(note.role);
      families.set(family, entry);
    } else if (note.code === 'empty_list' && note.role !== null) {
      empty.push(note.role);
    } else {
      rest.push(note);
    }
  }
  const folds = families.size > 0 || empty.length > 0;
  const hint: SetupLine[] =
    folds && view !== undefined && view.key !== ''
      ? [
          {
            key: 'n.hint',
            text: t(view.all ? 'setup.review.detailsHintAll' : 'setup.review.detailsHint', {
              key: view.key,
            }),
            dim: true,
          },
        ]
      : [];
  if (view?.all === true || !folds) {
    return [...notes.map((note, index) => noteLine(note, `n.${String(index)}`, t)), ...hint];
  }
  const lines: SetupLine[] = [];
  for (const [family, entry] of families) {
    lines.push({
      key: `n.family.${family}`,
      text: `[${t('setup.review.info')}] ${t('setup.review.noAccountFamily', {
        family,
        models: entry.heads.join(', '),
        count: entry.roles.size,
      })}`,
      dim: true,
    });
  }
  if (empty.length > 0) {
    lines.push({
      key: 'n.empty',
      text: `[${t('setup.review.warning')}] ${t('setup.review.emptyRoles', {
        count: empty.length,
        roles: empty.join(', '),
      })}`,
      color: TOKEN.warn,
    });
  }
  rest.forEach((note, index) => lines.push(noteLine(note, `n.${String(index)}`, t)));
  return [...lines, ...hint];
}

function finishedLines(run: SetupRunView, closeKey: string, t: TFunction): SetupLine[] {
  const lines: SetupLine[] = [];
  if (run.state === 'cancelled') {
    lines.push({ key: 'cancelled', text: t('setup.done.cancelled'), color: TOKEN.warn });
  } else {
    lines.push({ key: 'confirmed', text: t('setup.done.confirmed'), color: TOKEN.ok, bold: true });
    const result = run.result;
    if (result?.preset !== null && result?.preset !== undefined) {
      lines.push({ key: 'preset', text: t('setup.done.preset', { preset: result.preset }) });
    }
    if (result !== null && result.executors.length > 0) {
      lines.push({
        key: 'executors',
        text: t('setup.done.executors', { list: result.executors.join(', ') }),
      });
    }
    if (result !== null) {
      lines.push({
        key: 'written',
        text: t('setup.done.written', { list: list(result.written, t) }),
        dim: true,
      });
    }
  }
  lines.push({ key: 'close', text: t('setup.done.close', { key: closeKey }), dim: true });
  return lines;
}

/** The rows of the screen: the progress, the hint of the step and the step itself (or the end). */
export function setupLines(input: SetupLinesInput): SetupLine[] {
  const { run, draft, t, accounts } = input;
  const lines: SetupLine[] = [
    { key: 'progress', text: progress(run, t, accounts), bold: true },
    { key: 'gap', text: '' },
  ];
  const prompt = run.prompt;
  if (run.state !== 'active' || prompt === null) {
    return [...lines, ...finishedLines(run, input.closeKey, t)];
  }
  if (accounts?.active === true) {
    lines.push(
      { key: 'hint', text: t('setup.hint.accounts'), dim: true },
      { key: 'gap2', text: '' },
      ...accountsStageLines(run, accounts, t),
    );
    return lines;
  }
  lines.push(
    { key: 'hint', text: t(`setup.hint.${prompt.step}`), dim: true },
    { key: 'gap2', text: '' },
  );
  switch (prompt.step) {
    case 'detect':
      if (draft.kind === 'detect') lines.push(...detectLines(prompt, draft, t));
      break;
    case 'account':
      if (draft.kind === 'account') lines.push(...accountLines(prompt, draft, t));
      break;
    case 'preset':
      if (draft.kind === 'preset') lines.push(...presetLines(prompt, draft, t));
      break;
    case 'executors':
      if (draft.kind === 'executors') lines.push(...executorsLines(prompt, draft, t));
      break;
    case 'review':
      lines.push(...planLines(prompt.plan, t, input.reviewNotes));
      break;
  }
  return lines;
}
