// SPDX-License-Identifier: MPL-2.0
import {
  SETUP_ADAPTER_CLIENTS,
  type SetupAdapterClient,
  type SetupBudget,
  type SetupDetectedClient,
  type SetupExecutorRequest,
  type SetupPlan,
  type SetupPrompt,
  type SetupRolePlacement,
  type SetupRunView,
  type SetupStepSubmission,
} from '@otheater/protocol';
import {
  rowEffortMoved,
  rowToggled,
  rowsSubmission,
  type ExecutorGroup,
  type ExecutorRow,
} from './executor-list.js';

/**
 * What the setup screen keeps between the daemon's views (P17 of Phase 7): the draft of the step on
 * screen, as pure data and pure steps, so the screen only draws it and a test reads it without
 * Ink. The daemon holds the run (steps done, the step now); the draft is what the person is still
 * choosing at the current step, and it is lost when the screen closes: what survives is the run.
 */

export interface DetectRow {
  readonly profileId: string;
  readonly on: boolean;
}

export type Draft =
  | { readonly kind: 'detect'; readonly rows: readonly DetectRow[]; readonly cursor: number }
  | { readonly kind: 'account'; readonly cursor: number }
  | { readonly kind: 'preset'; readonly cursor: number }
  /** N334: the cursor is on 0 (keep: do not write) or 1 (write `security.unenforced: warn`). */
  | { readonly kind: 'security'; readonly cursor: number }
  | {
      readonly kind: 'executors';
      readonly executors: readonly SetupExecutorRequest[];
      /** The caps the person set, by account; an account that is not here takes the suggested one. */
      readonly budgets: Readonly<Record<string, SetupBudget>>;
      readonly cursor: number;
      /**
       * N324: the Executors of the preset the person unchecked in the list of models after a login
       * (the `exclude` of the step); none when absent.
       */
      readonly exclude?: readonly string[];
      /**
       * N333: the models of each account as the client catalog lists them, as rows to check; absent
       * until the list is read (and always absent with `ui.setup.executorsInput: prompt`).
       */
      readonly rows?: readonly ExecutorRow[];
      /** What the catalog said of each account, for the heading of its rows. */
      readonly groups?: readonly ExecutorGroup[];
      /** The list is being read (`loading`) or was read (`ready`); absent: it was not asked for. */
      readonly list?: 'loading' | 'ready';
      /**
       * N333 [proposta]: the roles given at the review to the Executors the preset leaves without
       * one; kept so the step, answered again, repeats them. Any edit of the step clears them.
       */
      readonly placements?: readonly SetupRolePlacement[];
    }
  | { readonly kind: 'review' };

/** The preset the cursor starts on when the configuration names none. [proposta] The middle one. */
export const DEFAULT_PRESET = 'balanced';

/** What the list of models after a login (N324) gives the step of the Executors to start with. */
export interface ExecutorsSeed {
  readonly executors: readonly SetupExecutorRequest[];
  readonly exclude: readonly string[];
}

/**
 * The draft a step opens with. [proposta] Detection starts with every usable account taken in, in
 * the order the daemon lists them (the same the daemon would use if the step sent no list); the
 * preset starts on the one in force, or on {@link DEFAULT_PRESET}; nothing is registered by default,
 * except what the list of models after a login chose (`seed`, N324).
 */
export function initialDraft(prompt: SetupPrompt | null, seed?: ExecutorsSeed): Draft {
  if (prompt === null) return { kind: 'review' };
  switch (prompt.step) {
    case 'detect':
      return {
        kind: 'detect',
        rows: prompt.profiles.map((profile) => ({
          profileId: profile.profileId,
          on: profile.usable,
        })),
        cursor: 0,
      };
    case 'account': {
      const usable = prompt.profiles.findIndex((profile) => profile.usable);
      return { kind: 'account', cursor: Math.max(0, usable) };
    }
    case 'preset': {
      const at = prompt.options.indexOf(prompt.current ?? DEFAULT_PRESET);
      return { kind: 'preset', cursor: Math.max(0, at) };
    }
    case 'security':
      // [proposta] The cursor starts on "no": the safe answer is the one Enter gives.
      return { kind: 'security', cursor: 0 };
    case 'executors':
      return {
        kind: 'executors',
        executors: [...(seed?.executors ?? [])],
        budgets: {},
        cursor: 0,
        ...(seed === undefined || seed.exclude.length === 0 ? {} : { exclude: [...seed.exclude] }),
      };
    case 'review':
      return { kind: 'review' };
  }
}

/**
 * The draft remembered for a step, brought up to date with what the daemon lists now (the owner on
 * 2026-11-26: "Reler e marcar"). Only the detection changes: an account the daemon no longer lists
 * leaves, a new one comes in at the end as {@link initialDraft} would take it (in when usable), and
 * an account added in this run (`added`) comes in checked when usable, whatever the draft said. The
 * rest keeps the person's marks and order. Any other step keeps the remembered draft.
 */
export function reconciledDraft(
  remembered: Draft,
  prompt: SetupPrompt | null,
  added: readonly string[],
): Draft {
  if (remembered.kind !== 'detect' || prompt?.step !== 'detect') return remembered;
  const usable = new Map(prompt.profiles.map((profile) => [profile.profileId, profile.usable]));
  const kept = remembered.rows
    .filter((row) => usable.has(row.profileId))
    .map((row) =>
      added.includes(row.profileId) ? { ...row, on: usable.get(row.profileId) === true } : row,
    );
  const known = new Set(kept.map((row) => row.profileId));
  const fresh = prompt.profiles
    .filter((profile) => !known.has(profile.profileId))
    .map((profile) => ({ profileId: profile.profileId, on: profile.usable }));
  const rows = [...kept, ...fresh];
  return { ...remembered, rows, cursor: Math.min(remembered.cursor, Math.max(0, rows.length - 1)) };
}

/** How many rows the cursor walks at the step. */
export function itemCount(draft: Draft, prompt: SetupPrompt | null): number {
  if (prompt === null) return 0;
  switch (draft.kind) {
    case 'detect':
      return draft.rows.length;
    case 'account':
      return prompt.step === 'account' ? prompt.profiles.length : 0;
    case 'preset':
      return prompt.step === 'preset' ? prompt.options.length : 0;
    case 'security':
      return prompt.step === 'security' ? 2 : 0;
    case 'executors':
      return (
        (draft.rows?.length ?? 0) +
        draft.executors.length +
        (prompt.step === 'executors' ? prompt.apiProfiles.length : 0)
      );
    case 'review':
      return 0;
  }
}

/** The draft with the cursor moved by `delta`, kept inside the rows. */
export function withCursor(draft: Draft, prompt: SetupPrompt | null, delta: number): Draft {
  if (draft.kind === 'review') return draft;
  const last = Math.max(0, itemCount(draft, prompt) - 1);
  return { ...draft, cursor: Math.min(last, Math.max(0, draft.cursor + delta)) };
}

/**
 * Takes the account under the cursor in or out of the detection; at the step of the Executors, the
 * model under the cursor in or out of the list (N333).
 */
export function toggled(draft: Draft): Draft {
  if (draft.kind === 'executors') {
    if (draft.rows === undefined || draft.cursor >= draft.rows.length) return draft;
    return edited(draft, { rows: rowToggled(draft.rows, draft.cursor) });
  }
  if (draft.kind !== 'detect') return draft;
  return {
    ...draft,
    rows: draft.rows.map((row, index) => (index === draft.cursor ? { ...row, on: !row.on } : row)),
  };
}

/**
 * N333: the effort of the model under the cursor, moved by `delta` among the ones it accepts
 * (←→). Nothing happens off the rows of the list.
 */
export function effortMoved(draft: Draft, delta: -1 | 1): Draft {
  if (draft.kind !== 'executors' || draft.rows === undefined) return draft;
  if (draft.cursor >= draft.rows.length) return draft;
  return edited(draft, { rows: rowEffortMoved(draft.rows, draft.cursor, delta) });
}

/** The draft of the Executors with a change; the roles given at the review are given up (any edit clears them). */
function edited(
  draft: Extract<Draft, { kind: 'executors' }>,
  change: Partial<Extract<Draft, { kind: 'executors' }>>,
): Draft {
  const next = { ...draft, ...change };
  delete next.placements;
  return next;
}

/** Moves the account under the cursor up or down the order (the cursor follows it). */
export function reordered(draft: Draft, delta: -1 | 1): Draft {
  if (draft.kind !== 'detect') return draft;
  const to = draft.cursor + delta;
  if (to < 0 || to >= draft.rows.length) return draft;
  const rows = [...draft.rows];
  const [row] = rows.splice(draft.cursor, 1);
  if (row === undefined) return draft;
  rows.splice(to, 0, row);
  return { ...draft, rows, cursor: to };
}

/**
 * What the cursor is on at the step of the Executors: a model of the list (N333), a typed line, or
 * a cap of an API account. The cursor walks them in that order.
 */
export type ExecutorsItem =
  | { readonly kind: 'row'; readonly index: number }
  | { readonly kind: 'executor'; readonly index: number }
  | { readonly kind: 'budget'; readonly profileId: string };

export function executorsItem(draft: Draft, prompt: SetupPrompt | null): ExecutorsItem | undefined {
  if (draft.kind !== 'executors' || prompt?.step !== 'executors') return undefined;
  const rows = draft.rows?.length ?? 0;
  if (draft.cursor < rows) return { kind: 'row', index: draft.cursor };
  const typed = draft.cursor - rows;
  if (typed < draft.executors.length) return { kind: 'executor', index: typed };
  const profile = prompt.apiProfiles[typed - draft.executors.length];
  return profile === undefined ? undefined : { kind: 'budget', profileId: profile.profileId };
}

export function withExecutor(draft: Draft, executor: SetupExecutorRequest): Draft {
  if (draft.kind !== 'executors') return draft;
  return edited(draft, {
    executors: [...draft.executors, executor],
    cursor: (draft.rows?.length ?? 0) + draft.executors.length,
  });
}

export function withoutExecutor(draft: Draft, index: number): Draft {
  if (draft.kind !== 'executors') return draft;
  const executors = draft.executors.filter((_, at) => at !== index);
  const rows = draft.rows?.length ?? 0;
  return edited(draft, {
    executors,
    cursor: Math.max(0, Math.min(draft.cursor, rows + executors.length - 1)),
  });
}

/** What the list of models read gives the step (N333): the rows and groups, merged with the seed of N324. */
export function withList(
  draft: Draft,
  list: {
    readonly rows: readonly ExecutorRow[];
    readonly groups: readonly ExecutorGroup[];
    readonly executors: readonly SetupExecutorRequest[];
    readonly exclude: readonly string[];
  },
): Draft {
  if (draft.kind !== 'executors') return draft;
  const next = {
    ...draft,
    executors: [...list.executors],
    rows: [...list.rows],
    groups: [...list.groups],
    list: 'ready' as const,
  };
  delete next.exclude;
  return list.exclude.length === 0 ? next : { ...next, exclude: [...list.exclude] };
}

/** The Executors of the plan the preset leaves without a role: the ones the review can give one. */
export function noRoleExecutors(plan: SetupPlan | undefined): readonly string[] {
  if (plan === undefined) return [];
  return plan.executors
    .map((executor) => executor.id)
    .filter((id) => !plan.roles.some((role) => role.executors.includes(id)));
}

export function withBudget(draft: Draft, budget: SetupBudget): Draft {
  if (draft.kind !== 'executors') return draft;
  return { ...draft, budgets: { ...draft.budgets, [budget.profileId]: budget } };
}

/**
 * What the Producer answers at the step, or `undefined` when there is nothing to answer yet (no
 * account under the cursor). What the daemon refuses is not decided here: the daemon validates,
 * and the screen shows what it said.
 */
export function submissionOf(
  draft: Draft,
  prompt: SetupPrompt | null,
): SetupStepSubmission | undefined {
  if (prompt === null) return undefined;
  switch (draft.kind) {
    case 'detect':
      return {
        step: 'detect',
        input: {
          accounts: draft.rows.filter((row) => row.on).map((row) => row.profileId),
        },
      };
    case 'account': {
      if (prompt.step !== 'account') return undefined;
      const profile = prompt.profiles[draft.cursor];
      return profile === undefined
        ? undefined
        : { step: 'account', input: { profileId: profile.profileId } };
    }
    case 'preset': {
      if (prompt.step !== 'preset') return undefined;
      const preset = prompt.options[draft.cursor];
      return preset === undefined ? undefined : { step: 'preset', input: { preset } };
    }
    case 'security':
      return prompt.step === 'security'
        ? { step: 'security', input: { warn: draft.cursor === 1 } }
        : undefined;
    case 'executors': {
      // N333: the models checked in the list are requests (or exclusions of what the preset names).
      const listed = rowsSubmission(draft.rows ?? []);
      const exclude = [...listed.exclude, ...(draft.exclude ?? [])].filter(
        (id, at, all) => all.indexOf(id) === at,
      );
      return {
        step: 'executors',
        input: {
          executors: [...listed.executors, ...draft.executors],
          budgets: Object.values(draft.budgets),
          ...(exclude.length === 0 ? {} : { exclude }),
          ...(draft.placements === undefined || draft.placements.length === 0
            ? {}
            : { roles: draft.placements.map((place) => ({ ...place, roles: [...place.roles] })) }),
        },
      };
    }
    case 'review':
      return undefined;
  }
}

/** `<account> <model> [effort]`; `undefined` when it has fewer than two words or more than three. */
export function parseExecutorLine(text: string): SetupExecutorRequest | undefined {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length < 2 || words.length > 3) return undefined;
  const [profileId, model, effort] = words;
  if (profileId === undefined || model === undefined) return undefined;
  return { profileId, model, ...(effort === undefined ? {} : { effort }) };
}

function usd(word: string): number | null | undefined {
  if (word === '-') return null;
  if (!/^\d+([.,]\d+)?$/.test(word)) return undefined;
  const value = Number(word.replace(',', '.'));
  return value > 0 ? value : undefined;
}

/** `<day> <month>`, each a number above zero or `-` for no cap; `undefined` when it is not that. */
export function parseBudgetLine(profileId: string, text: string): SetupBudget | undefined {
  const words = text.trim().split(/\s+/);
  if (words.length !== 2) return undefined;
  const [day, month] = words;
  if (day === undefined || month === undefined) return undefined;
  const dailyUsd = usd(day);
  const monthlyUsd = usd(month);
  if (dailyUsd === undefined || monthlyUsd === undefined) return undefined;
  return { profileId, dailyUsd, monthlyUsd };
}

/** The run is over (confirmed or cancelled): there is no step to answer. */
export function isFinished(run: SetupRunView): boolean {
  return run.state !== 'active';
}

/** The place of the step in its flow, from 1. */
export function stepNumber(run: SetupRunView): number {
  return Math.max(0, run.steps.indexOf(run.step)) + 1;
}

/** The first step has nothing before it: back leaves the assistant instead. */
export function atFirstStep(run: SetupRunView): boolean {
  return run.steps.indexOf(run.step) <= 0;
}

/** The key the drafts are remembered under: the same step of the same run. */
export function draftKey(run: SetupRunView): string {
  return `${run.id}/${run.step}`;
}

// ---- the step that adds an account (N274, 2026-11-22) -------------------------------------------

/** The clients the step offers when the detection names none. */
export const KNOWN_CLIENTS = ['claude-code', 'codex', 'opencode'] as const;

/**
 * The clients the step lists, in the order of the detection of the daemon (a client the machine
 * has is walked first only by the cursor start, not by the order).
 */
export function accountClients(prompt: SetupPrompt | null): readonly SetupDetectedClient[] {
  if (prompt?.step === 'detect' && prompt.clients.length > 0) return prompt.clients;
  return KNOWN_CLIENTS.map((client) => ({ client, installed: false }));
}

/**
 * The client whose ACP adapter the I key installs (P18b, N321): Claude Code or Codex, with its
 * official program there and the adapter missing. Any other client gets no install from here.
 */
export function adapterToInstall(
  entry: SetupDetectedClient | undefined,
): SetupAdapterClient | undefined {
  if (entry === undefined || entry.installed || entry.reason !== 'adapter_missing')
    return undefined;
  return (SETUP_ADAPTER_CLIENTS as readonly string[]).includes(entry.client)
    ? (entry.client as SetupAdapterClient)
    : undefined;
}

/** [proposta] The cursor of the step starts on the first client found on the machine, or the first one. */
export function accountsCursorStart(prompt: SetupPrompt | null): number {
  return Math.max(
    0,
    accountClients(prompt).findIndex((entry) => entry.installed),
  );
}

/** The cursor moved by `delta`, kept inside the list of clients. */
export function accountsCursorMoved(
  cursor: number,
  prompt: SetupPrompt | null,
  delta: number,
): number {
  const last = Math.max(0, accountClients(prompt).length - 1);
  return Math.min(last, Math.max(0, cursor + delta));
}

/** The command that logs in to an account in a terminal (what the daemon answers as `local`). */
export function loginCommandOf(profileId: string): string {
  return `ot profile exec ${profileId} login`;
}
