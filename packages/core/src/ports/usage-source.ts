// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';

/** Semver of the `UsageSource` port contract (architecture 5.18, "Versão dos contratos"). */
export const USAGE_SOURCE_PORT_VERSION = '0.1.0';

/**
 * What to ask a `UsageSource` (architecture 5.6, "Histórico de consumo"): the consumption of ONE
 * profile, read from the local logs of its client, over a range of days.
 *
 * - `clientId` is the client of the profile (`claude-code`, `codex`, `opencode`).
 * - `profileDir` is the isolated directory of the profile (`ProfileRecord.dir`). The source reads
 *   only inside it: it must never fall back to the directory of the user's own client, whose logs
 *   hold conversations of other work.
 * - `sinceDay` and `untilDay` are UTC calendar days (`YYYY-MM-DD`), both included. Both optional.
 */
export interface UsageSourceQuery {
  readonly clientId: string;
  readonly profileDir: string;
  readonly sinceDay?: string | undefined;
  readonly untilDay?: string | undefined;
}

/**
 * Consumption of one UTC day, by model when the tool says it. Only numbers and the model name: a
 * source never passes on text of a conversation, a path of a project or a credential. A count the
 * tool did not report is `null`, never a made-up zero, and so is a cost.
 */
export interface UsageSourceEntry {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** The model, or `null` when the tool gave only a total for the day. */
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** What the tool priced the tokens at (US$): an estimate, not what an account was charged. */
  readonly costUsd: number | null;
}

/** Why a source cannot be used: it is not there, it is not the version required, or it failed. */
export const USAGE_SOURCE_FAILURES = ['not_found', 'wrong_version', 'failed'] as const;
export type UsageSourceFailure = (typeof USAGE_SOURCE_FAILURES)[number];

/** The answer of {@link UsageSource.check}. */
export type UsageSourceStatus =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: UsageSourceFailure; readonly detail: string };

/**
 * A history of consumption read outside the sessions (architecture 5.6, 5.18): the default adapter
 * is the `ccusage` CLI, a level C tool (a separate process the user installs). The history is a
 * second source, to compare with what the sessions reported; it is never the first one, and it
 * does not tell the quota left.
 *
 * Contract:
 * - `check` never rejects: it resolves `{ ok: false }` with the reason when the tool is missing,
 *   is not the version the adapter requires, or does not run.
 * - `read` rejects with `AdapterUnavailable` when the tool cannot be run or answers something that
 *   is not understood, and with `InvalidInput` for a query that is not valid (a day that is not
 *   `YYYY-MM-DD`, a directory that is not absolute). An empty history resolves `[]`.
 * - Both only read. The adapter always points the tool at the directory of the profile and never at
 *   the user's own, whatever the environment of the daemon says.
 */
export interface UsageSource extends Adapter {
  check(): Promise<UsageSourceStatus>;
  read(query: UsageSourceQuery): Promise<readonly UsageSourceEntry[]>;
}
