// SPDX-License-Identifier: MPL-2.0
import type {
  SetupDetectedClient,
  SetupDetectedProfile,
  SetupNote,
  SetupPlan,
  SetupPrompt,
  SetupRunView,
} from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { TOKEN } from '../layout/theme.js';
import { rowRoles, type ExecutorRow } from './executor-list.js';
import { accountClients, noRoleExecutors, stepNumber, type Draft } from './model.js';

/** One row of the setup screen, before it is cut to the width. */
export interface SetupLine {
  readonly key: string;
  readonly text: string;
  readonly color?: string | undefined;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /** The row under the cursor. */
  readonly selected?: boolean;
  /** Spaces before the text, kept on every row it wraps to (2026-11-26); default none. */
  readonly indent?: number;
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
  /**
   * The plan the review showed, kept by the screen (2026-11-26) [proposta]: the finished screen
   * repeats its summary. Absent (a run confirmed elsewhere), it lists what the result holds.
   */
  readonly confirmedPlan?: SetupPlan | undefined;
  /**
   * N333: the review lets the person give roles to an Executor that has none: which of those the
   * cursor is on, and the label of the key (P). Absent: the review draws no cursor.
   */
  readonly reviewRoles?: ReviewRolesView | undefined;
}

/** The cursor of the review over the Executors with no role (N333). */
export interface ReviewRolesView {
  readonly cursor: number;
  readonly key: string;
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

/**
 * N334 [proposta]: the risk in words, then the two answers. The first (the cursor start) changes
 * nothing; the second makes the plan write `security.unenforced: warn`.
 */
function securityLines(
  prompt: Extract<SetupPrompt, { step: 'security' }>,
  draft: Extract<Draft, { kind: 'security' }>,
  t: TFunction,
): SetupLine[] {
  return [
    {
      key: 's.risk',
      text: t('setup.security.risk', { value: prompt.unenforced }),
      color: TOKEN.warn,
    },
    { key: 's.gap', text: '' },
    { key: 's.no', text: t('setup.security.no'), selected: draft.cursor === 0 },
    { key: 's.yes', text: t('setup.security.yes'), selected: draft.cursor === 1 },
  ];
}

/** The line of a model of the list (N333): `[x] model ‹effort›  → roles`. */
function rowText(row: ExecutorRow, roles: readonly string[], t: TFunction): string {
  const box = row.registered ? '[=]' : row.on ? '[x]' : '[ ]';
  const name = row.name !== null && row.name !== row.model ? ` (${row.name})` : '';
  const effort = row.effort === null || row.registered ? '' : `  ‹${row.effort}›`;
  const tags = [
    ...(row.floating === null ? [] : [t(`setup.models.floating.${row.floating}`)]),
    ...(row.registered ? [t('setup.models.registered')] : []),
  ];
  const beside =
    row.on && roles.length > 0
      ? `  ${t('setup.executors.rowRoles', { roles: roles.join(', ') })}`
      : '';
  return `${box} ${row.model}${name}${effort}${beside}${tags.length > 0 ? `  ${tags.join(', ')}` : ''}`;
}

/** What a group of the list says when it has no rows, or why its models could not be listed. */
function groupNote(
  group: NonNullable<Extract<Draft, { kind: 'executors' }>['groups']>[number],
  rows: number,
  t: TFunction,
): string | undefined {
  switch (group.catalog) {
    case 'listed':
      return rows === 0 ? t('setup.executors.noModels') : undefined;
    case 'assisted':
      return t('setup.executors.assisted');
    case 'none':
      return t('setup.executors.noClient');
    case 'unavailable':
      return t('setup.executors.unavailable', { reason: group.reason ?? '' });
    case 'failed':
      return t('setup.executors.listFailed', { reason: group.reason ?? '' });
  }
}

function executorsLines(
  prompt: Extract<SetupPrompt, { step: 'executors' }>,
  draft: Extract<Draft, { kind: 'executors' }>,
  t: TFunction,
  run?: SetupRunView,
): SetupLine[] {
  const rows = draft.rows ?? [];
  const lines: SetupLine[] = [
    { key: 'h.list', text: t('setup.executors.listTitle'), color: TOKEN.accent, bold: true },
  ];
  if (draft.list === 'loading') {
    lines.push({ key: 'e.loading', text: t('setup.executors.loading'), dim: true });
  }
  // N333: per account, the models its client lists, with the effort and the roles beside each one.
  for (const group of draft.groups ?? []) {
    const own = rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.profileId === group.profileId);
    lines.push({ key: `g.${group.profileId}`, text: group.profileId, bold: true });
    const note = groupNote(group, own.length, t);
    if (note !== undefined)
      lines.push({ key: `g.${group.profileId}.note`, indent: 2, text: note, dim: true });
    for (const { row, index } of own) {
      lines.push({
        key: `r.${String(index)}`,
        indent: 2,
        text: rowText(row, rowRoles(run, row), t),
        selected: index === draft.cursor,
        ...(row.registered ? { dim: true } : {}),
      });
    }
  }
  if (draft.executors.length === 0 && rows.length === 0 && draft.list !== 'loading') {
    lines.push({ key: 'e.none', text: t('setup.executors.none'), dim: true });
  }
  if (draft.exclude !== undefined && draft.exclude.length > 0) {
    lines.push({
      key: 'e.excluded',
      text: t('setup.executors.excluded', {
        count: draft.exclude.length,
        list: draft.exclude.join(', '),
      }),
      dim: true,
    });
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
      selected: rows.length + index === draft.cursor,
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
      selected: rows.length + draft.executors.length + index === draft.cursor,
    });
  });
  return lines;
}

/** The `<model>-<effort>` and the account of an Executor id (`<head>@<client>/<profile>`). */
function splitId(id: string): { head: string; profileId: string | null } {
  const at = id.lastIndexOf('@');
  return at <= 0
    ? { head: id, profileId: null }
    : { head: id.slice(0, at), profileId: id.slice(at + 1) };
}

/** An account that the detection found and that does not take part, with why (2026-11-26). */
interface AccountOut {
  readonly profileId: string;
  readonly reason: string;
}

/** The accounts that take part in the run, in the order the lists take them. */
function takingOf(run: SetupRunView | undefined): readonly string[] {
  for (const step of run?.done ?? []) {
    if (step.step === 'detect') return step.output.accounts;
    if (step.step === 'account') return [step.output.profile.profileId];
  }
  return [];
}

/** The accounts the detection found that do not take part, with why. */
function outOf(run: SetupRunView | undefined, t: TFunction): readonly AccountOut[] {
  const detect = run?.done.find((step) => step.step === 'detect');
  if (detect?.step !== 'detect') return [];
  const taking = detect.output.accounts;
  return detect.output.profiles
    .filter((profile) => !taking.includes(profile.profileId))
    .map((profile) => ({ profileId: profile.profileId, reason: outReason(profile, t) }));
}

function outReason(profile: SetupDetectedProfile, t: TFunction): string {
  if (profile.usable) return t('setup.review.out.unmarked');
  if (profile.state !== 'active') return t(`settings.profile.${profile.state}`);
  if (profile.login === 'logged_out') return t('setup.review.out.loggedOut');
  if (profile.kind === 'api' && !profile.hasSecret) return t('setup.review.out.noKey');
  return t('setup.detect.unusable');
}

function padded(items: readonly string[]): (item: string) => string {
  const width = Math.max(0, ...items.map((item) => item.length));
  return (item) => item.padEnd(width);
}

/**
 * The review (2026-11-26, the owner's "Por conta"): the accounts, each with the Executors it gives
 * and the roles they serve, then the accounts left out with why; the roles one per line with what
 * happens when they run out; the notes worded by cause; and the keys written folded into a count.
 * The names of the Executors drop the account when only one account takes part. D (the `details`
 * key) unfolds the notes and the keys.
 */
function planLines(
  plan: SetupPlan,
  t: TFunction,
  view?: ReviewNotesView,
  run?: SetupRunView,
  roles?: ReviewRolesView,
): SetupLine[] {
  return [
    ...summaryLines(plan, t, run, roles),
    ...notesLines(plan.notes, t, view, nameOf(plan, run)),
    ...writesLines(plan.writes, t, view),
  ];
}

/** How the review names an Executor: without the account when only one account takes part. */
function nameOf(plan: SetupPlan, run: SetupRunView | undefined): (id: string) => string {
  const ids = [
    ...plan.executors.map((executor) => executor.id),
    ...plan.roles.flatMap((role) => role.executors),
  ];
  const accounts = new Set([...ids.map((id) => splitId(id).profileId ?? id), ...takingOf(run)]);
  return accounts.size <= 1 ? (id) => splitId(id).head : (id) => id;
}

/** The preset, the accounts and the roles: what the review and the finished screen both show. */
function summaryLines(
  plan: SetupPlan,
  t: TFunction,
  run: SetupRunView | undefined,
  pick?: ReviewRolesView,
): SetupLine[] {
  const lines: SetupLine[] = [
    {
      key: 'preset',
      text:
        plan.preset === null
          ? t('setup.review.presetKept')
          : t('setup.review.preset', { preset: plan.preset }),
      bold: true,
    },
  ];
  const name = nameOf(plan, run);
  const taking = takingOf(run);
  const out = outOf(run, t);
  // N333: the Executor with no role the cursor is on (P gives it roles).
  const under = pick === undefined ? undefined : noRoleExecutors(plan)[pick.cursor];
  const ids = [
    ...plan.executors.map((executor) => executor.id),
    ...plan.roles.flatMap((role) => role.executors),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const accounts = [
    ...taking,
    ...ids.map((id) => splitId(id).profileId).filter((id): id is string => id !== null),
  ].filter((id, index, all) => all.indexOf(id) === index);
  // A flow with no account of its own (changing the preset) and nothing in the lists: no section.
  if (accounts.length > 0 || out.length > 0) {
    lines.push({
      key: 'h.accounts',
      text: t('setup.review.accounts'),
      color: TOKEN.accent,
      bold: true,
    });
  }
  const pad = padded([...accounts, ...out.map((entry) => entry.profileId)]);
  for (const profileId of accounts) {
    const fresh = plan.executors.filter((executor) => executor.profileId === profileId).length;
    lines.push({
      key: `a.${profileId}`,
      indent: 2,
      text: `${pad(profileId)}  ${
        fresh === 0
          ? t('setup.review.noNewExecutors')
          : t('setup.review.newExecutors', { count: fresh })
      }`,
      bold: true,
    });
    const own = ids.filter((id) => splitId(id).profileId === profileId);
    const padHead = padded(own.map((id) => splitId(id).head));
    for (const id of own) {
      const roles = plan.roles
        .filter((role) => role.executors.includes(id))
        .map((role) => role.role);
      const selected = pick !== undefined && roles.length === 0 && id === under;
      lines.push({
        key: `x.${id}`,
        indent: 4,
        text: `${padHead(splitId(id).head)}  ${
          roles.length === 0
            ? t('setup.review.noRole') +
              (selected ? `  (${t('setup.review.giveRole', { key: pick.key })})` : '')
            : roles.join(', ')
        }`,
        ...(selected ? { selected: true } : {}),
      });
    }
    const budget = plan.budgets.find((entry) => entry.profileId === profileId);
    if (budget !== undefined) {
      lines.push({
        key: `b.${profileId}`,
        indent: 4,
        text: t('setup.review.budget', {
          daily: usdText(budget.dailyUsd, t),
          monthly: usdText(budget.monthlyUsd, t),
        }),
        dim: true,
      });
    }
  }
  for (const entry of out) {
    lines.push({
      key: `o.${entry.profileId}`,
      indent: 2,
      text: `${pad(entry.profileId)}  ${t('setup.review.out.line', { reason: entry.reason })}`,
      dim: true,
    });
  }
  const shown = plan.roles.map((role) =>
    role.executors.length === 0
      ? t('setup.review.noExecutors')
      : role.executors.map(name).join(', '),
  );
  if (plan.roles.length === 0) return lines;
  const roleWidth = Math.max(0, ...plan.roles.map((role) => role.role.length));
  const listWidth = Math.max(0, ...shown.map((text) => text.length));
  lines.push({
    key: 'h.roles',
    text: `${t('setup.review.roles').padEnd(roleWidth + listWidth + 6)}${t('setup.review.whenExhausted')}`,
    color: TOKEN.accent,
    bold: true,
  });
  plan.roles.forEach((role, index) => {
    lines.push({
      key: `r.${role.role}`,
      indent: 2,
      text: `${role.role.padEnd(roleWidth)}  ${(shown[index] ?? '').padEnd(listWidth)}  ${t(`settings.role.${role.whenExhausted}`)}`,
    });
  });
  return lines;
}

/** The keys written: a count, or (with D) the list. */
function writesLines(
  writes: readonly string[],
  t: TFunction,
  view: ReviewNotesView | undefined,
): SetupLine[] {
  if (writes.length === 0)
    return [{ key: 'writes', text: t('setup.review.writesNone'), dim: true }];
  if (view?.all === true) {
    return [
      { key: 'h.writes', text: t('setup.review.writes'), color: TOKEN.accent, bold: true },
      ...writes.map((key) => ({ key: `w.${key}`, indent: 2, text: key, dim: true })),
    ];
  }
  return [
    {
      key: 'writes',
      text: withMore(t('setup.review.writesCount', { count: writes.length }), view, t),
      dim: true,
    },
  ];
}

/** A folded line with the key that unfolds it (`· D detalha`), when the screen has that key. */
function withMore(text: string, view: ReviewNotesView | undefined, t: TFunction): string {
  return view === undefined || view.key === '' || view.all
    ? text
    : `${text} · ${t('setup.review.more', { key: view.key })}`;
}

/**
 * The family of a head of the preset, for the folded review (N324): what comes before the first `-`
 * (`claude-opus-high` → `claude`, `codex-sol-high` → `codex`). [proposta] The family, and not the
 * client, because a head of the preset names a model and no client.
 */
export function familyOf(head: string): string {
  return head.split('-')[0] ?? head;
}

const NOTE_MARK = { warning: '⚠', info: '·' } as const;

/** What the notes of one cause are about, for the line that words them. */
interface NoteGroup {
  readonly severity: SetupNote['severity'];
  readonly code: string;
  readonly notes: SetupNote[];
}

function unique(items: readonly (string | null | undefined)[]): string[] {
  return items.filter(
    (item, index, all): item is string => typeof item === 'string' && all.indexOf(item) === index,
  );
}

/**
 * The words of the notes of one cause (2026-11-26): `setup.review.note.<code>_<severity>` or
 * `setup.review.note.<code>`, given what they are about; `null` when the locale has neither (a code
 * the TUI does not know yet), and then the daemon's own messages show.
 */
function noteText(group: NoteGroup, t: TFunction, name: (id: string) => string): string | null {
  const { notes } = group;
  const text = t(
    [`setup.review.note.${group.code}_${group.severity}`, `setup.review.note.${group.code}`],
    {
      defaultValue: '',
      executors: unique(notes.map((note) => note.executorId))
        .map(name)
        .join(', '),
      roles: unique(notes.map((note) => note.role)).join(', '),
      profiles: unique(notes.map((note) => note.profileId)).join(', '),
      heads: unique(notes.map((note) => note.head)).join(', '),
      family: unique(
        notes.map((note) => (note.head === undefined ? undefined : familyOf(note.head))),
      ).join(', '),
      count:
        group.code === 'noAccountFamily'
          ? unique(notes.map((note) => note.head)).length
          : notes.length,
    },
  );
  return text === '' ? null : text;
}

function markLine(severity: SetupNote['severity'], key: string, text: string): SetupLine {
  return {
    key,
    text: `${NOTE_MARK[severity]} ${text}`,
    color: severity === 'warning' ? TOKEN.warn : undefined,
    dim: severity === 'info',
  };
}

/**
 * The notes of the review, worded by cause (N324; 2026-11-26). Folded: one line per cause (the
 * models of the preset with no account, one per family of models), each with the key that unfolds
 * it. `all`: one line per note, with the daemon's message under it. A code the locale does not word
 * shows the daemon's messages as they are.
 */
function notesLines(
  notes: readonly SetupNote[],
  t: TFunction,
  view: ReviewNotesView | undefined,
  name: (id: string) => string,
): SetupLine[] {
  const lines: SetupLine[] = [];
  if (view?.all === true) {
    notes.forEach((note, index) => {
      const key = `n.${String(index)}`;
      const text = noteText({ severity: note.severity, code: note.code, notes: [note] }, t, name);
      lines.push(markLine(note.severity, key, text ?? note.message));
      if (text !== null) lines.push({ key: `${key}.m`, indent: 2, text: note.message, dim: true });
    });
    if (notes.length > 0 && view.key !== '') {
      lines.push({
        key: 'n.hint',
        text: t('setup.review.detailsHintAll', { key: view.key }),
        dim: true,
      });
    }
    return lines;
  }
  const groups = new Map<string, NoteGroup>();
  for (const note of notes) {
    // The models of the preset with no account fold by family; the other notes by their cause.
    const id =
      note.code === 'no_account' && note.head !== undefined
        ? `${note.severity}:${note.code}:${familyOf(note.head)}`
        : `${note.severity}:${note.code}`;
    const group = groups.get(id) ?? { severity: note.severity, code: note.code, notes: [] };
    group.notes.push(note);
    groups.set(id, group);
  }
  for (const [id, group] of groups) {
    const text = noteText(
      group.code === 'no_account'
        ? { ...group, code: 'noAccountFamily', notes: group.notes }
        : group,
      t,
      name,
    );
    if (text === null) {
      group.notes.forEach((note, index) =>
        lines.push(markLine(note.severity, `n.${id}.${String(index)}`, note.message)),
      );
      continue;
    }
    // Only a line that folds several notes names the key that unfolds them.
    lines.push(
      markLine(group.severity, `n.${id}`, group.notes.length > 1 ? withMore(text, view, t) : text),
    );
  }
  return lines;
}

function finishedLines(input: SetupLinesInput): SetupLine[] {
  const { run, t, closeKey } = input;
  const lines: SetupLine[] = [];
  if (run.state === 'cancelled') {
    lines.push({ key: 'cancelled', text: t('setup.done.cancelled'), color: TOKEN.warn });
    lines.push({ key: 'close', text: t('setup.done.close', { key: closeKey }), dim: true });
    return lines;
  }
  lines.push({
    key: 'confirmed',
    text: `✓ ${t('setup.done.confirmed')}`,
    color: TOKEN.ok,
    bold: true,
  });
  const result = run.result;
  const plan = input.confirmedPlan;
  if (plan !== undefined) {
    // The summary of the review, as it was confirmed (the owner's "Resumo igual à Revisão").
    lines.push({ key: 'gap.s', text: '' }, ...summaryLines(plan, t, run));
  } else {
    if (result?.preset !== null && result?.preset !== undefined) {
      lines.push({ key: 'preset', text: t('setup.done.preset', { preset: result.preset }) });
    }
    if (result !== null && result.executors.length > 0) {
      lines.push({
        key: 'executors',
        text: t('setup.done.executors', { list: result.executors.join(', ') }),
      });
    }
  }
  if (result !== null) {
    lines.push({
      key: 'written',
      text:
        result.written.length === 0
          ? t('setup.review.writesNone')
          : `✓ ${t('setup.done.writtenCount', { count: result.written.length })}`,
      color: result.written.length === 0 ? undefined : TOKEN.ok,
      dim: result.written.length === 0,
    });
  }
  if (result?.restart !== undefined && result.restart.length > 0) {
    // N334: `security.unenforced` is copied into the adapters when the daemon starts.
    lines.push({
      key: 'restart',
      text: `⚠ ${t('setup.done.restart', { keys: result.restart.join(', ') })}`,
      color: TOKEN.warn,
    });
  }
  lines.push({ key: 'gap.n', text: '' });
  lines.push({
    key: 'next',
    text: t('setup.done.next'),
    bold: true,
  });
  lines.push({ key: 'close', text: t('setup.done.close', { key: closeKey }), dim: true });
  return lines;
}

/** The hint of a step: the Executors step with the list of models (N333) has its own. */
function hintOf(step: string, draft: Draft): string {
  return step === 'executors' && draft.kind === 'executors' && (draft.rows?.length ?? 0) > 0
    ? 'executorsList'
    : step;
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
    return [...lines, ...finishedLines(input)];
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
    { key: 'hint', text: t(`setup.hint.${hintOf(prompt.step, draft)}`), dim: true },
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
    case 'security':
      if (draft.kind === 'security') lines.push(...securityLines(prompt, draft, t));
      break;
    case 'executors':
      if (draft.kind === 'executors') lines.push(...executorsLines(prompt, draft, t, run));
      break;
    case 'review':
      lines.push(...planLines(prompt.plan, t, input.reviewNotes, run, input.reviewRoles));
      break;
  }
  return lines;
}
