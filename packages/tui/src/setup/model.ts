// SPDX-License-Identifier: MPL-2.0
import {
  SETUP_ADAPTER_CLIENTS,
  type SetupAdapterClient,
  type SetupBudget,
  type SetupDetectedClient,
  type SetupExecutorRequest,
  type SetupPrompt,
  type SetupRunView,
  type SetupStepSubmission,
} from '@otheater/protocol';

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
  | {
      readonly kind: 'executors';
      readonly executors: readonly SetupExecutorRequest[];
      /** The caps the person set, by account; an account that is not here takes the suggested one. */
      readonly budgets: Readonly<Record<string, SetupBudget>>;
      readonly cursor: number;
    }
  | { readonly kind: 'review' };

/** The preset the cursor starts on when the configuration names none. [proposta] The middle one. */
export const DEFAULT_PRESET = 'balanced';

/**
 * The draft a step opens with. [proposta] Detection starts with every usable account taken in, in
 * the order the daemon lists them (the same the daemon would use if the step sent no list); the
 * preset starts on the one in force, or on {@link DEFAULT_PRESET}; nothing is registered by default.
 */
export function initialDraft(prompt: SetupPrompt | null): Draft {
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
    case 'executors':
      return { kind: 'executors', executors: [], budgets: {}, cursor: 0 };
    case 'review':
      return { kind: 'review' };
  }
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
    case 'executors':
      return prompt.step === 'executors'
        ? draft.executors.length + prompt.apiProfiles.length
        : draft.executors.length;
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

/** Takes the account under the cursor in or out of the detection. */
export function toggled(draft: Draft): Draft {
  if (draft.kind !== 'detect') return draft;
  return {
    ...draft,
    rows: draft.rows.map((row, index) => (index === draft.cursor ? { ...row, on: !row.on } : row)),
  };
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

/** What the cursor is on at the step of the Executors: a registered line, or a cap of an API account. */
export type ExecutorsItem =
  | { readonly kind: 'executor'; readonly index: number }
  | { readonly kind: 'budget'; readonly profileId: string };

export function executorsItem(draft: Draft, prompt: SetupPrompt | null): ExecutorsItem | undefined {
  if (draft.kind !== 'executors' || prompt?.step !== 'executors') return undefined;
  if (draft.cursor < draft.executors.length) return { kind: 'executor', index: draft.cursor };
  const profile = prompt.apiProfiles[draft.cursor - draft.executors.length];
  return profile === undefined ? undefined : { kind: 'budget', profileId: profile.profileId };
}

export function withExecutor(draft: Draft, executor: SetupExecutorRequest): Draft {
  if (draft.kind !== 'executors') return draft;
  return { ...draft, executors: [...draft.executors, executor], cursor: draft.executors.length };
}

export function withoutExecutor(draft: Draft, index: number): Draft {
  if (draft.kind !== 'executors') return draft;
  const executors = draft.executors.filter((_, at) => at !== index);
  return { ...draft, executors, cursor: Math.max(0, Math.min(draft.cursor, executors.length - 1)) };
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
    case 'executors':
      return {
        step: 'executors',
        input: { executors: [...draft.executors], budgets: Object.values(draft.budgets) },
      };
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
