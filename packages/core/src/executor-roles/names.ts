// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import { PROFILE_NAME_PATTERN } from '../ports/executor.js';

/**
 * The name of an Executor (architecture 5.7): `<model>-<effort>@<client>/<profile>`, or
 * `<model>@<client>/<profile>` for a model with no effort control. The part before the `@` (the
 * "head") is what a role preset writes, with no account: `claude-opus-high`.
 */

/** The abstract efforts of the configuration (5.7). */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What a model name (the part before the effort) may be: lower case, `-`, `.` and `_` inside. */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._]*(-[a-z0-9._]+)*$/;

/** The provider each official client serves, fixed by the client (5.7, "Provedor de um Executor"). */
export const FIXED_PROVIDER_OF_CLIENT: Readonly<Record<string, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** The official client of a provider: with a subscription, a family runs only through it (5.7). */
export const OFFICIAL_CLIENT_OF_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'claude-code',
  openai: 'codex',
};

/** The provider of an Executor with no `provider` that its client does not fix (5.7). */
export const UNKNOWN_PROVIDER = 'unknown';

/**
 * The provider of an Executor: fixed by the client for Claude Code and Codex, else the given one,
 * else `unknown` (which the cross-review treats as different from all, 5.7).
 */
export function providerOfClient(client: string, given?: string): string {
  return FIXED_PROVIDER_OF_CLIENT[client] ?? given ?? UNKNOWN_PROVIDER;
}

/** A name that splits into the parts of 5.7. */
export interface ParsedExecutorId {
  readonly id: string;
  /** `<model>-<effort>` (or `<model>`): what a preset writes. */
  readonly head: string;
  readonly model: string;
  readonly effort: EffortLevel | null;
  readonly client: string;
  readonly profile: string;
  /** `<client>/<profile>`. */
  readonly profileId: string;
}

/** Splits `<model>-<effort>` (what a preset writes) or `<model>`; a string is the reason it fails. */
export function splitHead(head: string): { model: string; effort: EffortLevel | null } | string {
  if (!MODEL_PATTERN.test(head)) {
    return `"${head}" is not a model name (lower case letters, digits, "-", "." and "_")`;
  }
  const last = head.slice(head.lastIndexOf('-') + 1);
  const effort = EFFORT_LEVELS.find((level) => level === last);
  if (effort === undefined) return { model: head, effort: null };
  const model = head.slice(0, head.length - effort.length - 1);
  if (model === '') return `"${head}" has an effort and no model`;
  return { model, effort };
}

/** {@link parseExecutorId} that answers the reason as a string instead of throwing. */
export function tryParseExecutorId(id: string): ParsedExecutorId | string {
  const at = id.indexOf('@');
  if (at <= 0 || id.slice(at + 1).includes('@')) {
    return `"${id}" is not an Executor name: expected <model>-<effort>@<client>/<profile>`;
  }
  const head = id.slice(0, at);
  const profileId = id.slice(at + 1);
  const split = splitHead(head);
  if (typeof split === 'string') return `"${id}": ${split}`;
  const parts = profileId.split('/');
  const [client, profile] = parts;
  if (
    parts.length !== 2 ||
    client === undefined ||
    profile === undefined ||
    !PROFILE_NAME_PATTERN.test(client) ||
    !PROFILE_NAME_PATTERN.test(profile)
  ) {
    return `"${id}": the account after "@" must be <client>/<profile>`;
  }
  return { id, head, model: split.model, effort: split.effort, client, profile, profileId };
}

/** Splits an Executor name; throws `InvalidInput` when it is malformed. */
export function parseExecutorId(id: string): ParsedExecutorId {
  const parsed = tryParseExecutorId(id);
  if (typeof parsed === 'string') throw new InvalidInput(parsed);
  return parsed;
}
