// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { JsonValueSchema } from './event-log.js';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

export const DIRECTIVE_KINDS = ['instruction', 'rule', 'suspension'] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

export const DIRECTIVE_SCOPES = ['global', 'local'] as const;
export type DirectiveScope = (typeof DIRECTIVE_SCOPES)[number];

export const DIRECTIVE_STATES = ['scheduled', 'active', 'expired', 'revoked'] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

/** Where a directive was written from (architecture 5.17). */
export const DIRECTIVE_ORIGINS = ['chat', 'tui', 'terminal', 'import'] as const;
export type DirectiveOrigin = (typeof DIRECTIVE_ORIGINS)[number];

/** Default time zone of a directive's validity (architecture 5.17). */
export const DEFAULT_DIRECTIVE_TIMEZONE = 'America/Sao_Paulo';

/** Directive ids are `O<n>`, numbered across the whole store from 1. */
export const DIRECTIVE_ID_PATTERN = /^O[1-9][0-9]*$/;

const text = z.string().min(1);

/**
 * One row of `directives` (architecture 5.17 and section 7), without the recurring window (after
 * v1). The row says what was ordered and when it is valid; the daemon applies it.
 */
export const DirectiveRecordSchema = z.strictObject({
  /** `O<n>`, assigned by the store. */
  id: z.string().regex(DIRECTIVE_ID_PATTERN),
  /** The `n` of the id. */
  seq: z.int().min(1),
  scope: z.enum(DIRECTIVE_SCOPES),
  /** The scenario of a local directive; null for a global one. */
  scenarioId: RecordIdSchema.nullable(),
  kind: z.enum(DIRECTIVE_KINDS),
  text,
  /** Configuration key of a `rule`. */
  ruleKey: text.nullable(),
  /** Value of a `rule` for that key. */
  ruleValue: JsonValueSchema,
  /** Id of the global directive a `suspension` takes out of its scenario. */
  suspendsId: z.string().regex(DIRECTIVE_ID_PATTERN).nullable(),
  /** Roles it reaches; empty means all roles. */
  roles: z.array(text),
  /** Epoch ms the validity starts. */
  startsAt: EpochMsSchema,
  /** Epoch ms the validity ends (exclusive); null means until revoked. */
  endsAt: EpochMsSchema.nullable(),
  timezone: text,
  state: z.enum(DIRECTIVE_STATES),
  origin: z.enum(DIRECTIVE_ORIGINS),
  /** The directive this one replaces, if any. */
  replacesId: z.string().regex(DIRECTIVE_ID_PATTERN).nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  revokedAt: EpochMsSchema.nullable(),
  revokeReason: text.nullable(),
});
export type DirectiveRecord = z.infer<typeof DirectiveRecordSchema>;

/**
 * What a caller writes. The store assigns `id` and `seq`, stamps the dates and derives `state`
 * from the validity and the clock: `scheduled` when it starts in the future, `expired` when it
 * already ended, `active` otherwise. `startsAt` defaults to the moment of creation.
 */
export const NewDirectiveSchema = DirectiveRecordSchema.omit({
  id: true,
  seq: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
  revokeReason: true,
}).partial({
  scenarioId: true,
  ruleKey: true,
  ruleValue: true,
  suspendsId: true,
  roles: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  replacesId: true,
});
export type NewDirective = z.infer<typeof NewDirectiveSchema>;

/** Prolongs or shortens the validity of a directive (5.17, `extend`). */
export const DirectiveValiditySchema = z.strictObject({
  startsAt: EpochMsSchema.optional(),
  endsAt: EpochMsSchema.nullable().optional(),
});
export type DirectiveValidity = z.infer<typeof DirectiveValiditySchema>;

export interface DirectiveListFilter {
  readonly scope?: DirectiveScope;
  readonly scenarioId?: string;
  readonly kinds?: readonly DirectiveKind[];
  readonly states?: readonly DirectiveState[];
}

/** What "in force" means for {@link DirectiveRegistry.inForce}. */
export interface DirectiveForceQuery {
  /** The scenario: its local directives and the global ones (minus the suspended). */
  readonly scenarioId: string;
  /** Only directives that reach this role (a directive without roles reaches all). */
  readonly role?: string;
}

/**
 * Registry of directives, part of `Store`. Contract (`describeDirectiveConformance`):
 * - `create` validates (a local directive needs a `scenarioId` and a global one must not have it;
 *   a `rule` needs `ruleKey`; a `suspension` needs `suspendsId`; `endsAt` is after `startsAt`),
 *   assigns `O<n>` (1, 2, 3... across the store) and the initial state described at
 *   {@link NewDirectiveSchema}. Failures reject with `InvalidInput`.
 * - `update validity` is `extend`: it changes `startsAt` and `endsAt`, re-derives the state and
 *   rejects with `Conflict` for a revoked directive.
 * - `revoke` is definitive: it sets `state` `revoked`, `revokedAt` and the reason; revoking one
 *   already revoked rejects with `Conflict`.
 * - `refreshStates` moves `scheduled` to `active` and `active` to `expired` by the clock, and
 *   resolves with the directives that changed (the daemon records `directive.validity_changed`).
 * - `inForce` lists the directives of a scenario that are `active` now, with the global ones a
 *   local `suspension` in force takes out removed, in id order.
 * - `list` is ordered by `seq`.
 */
export interface DirectiveRegistry {
  create(input: NewDirective): Promise<DirectiveRecord>;
  get(id: string): Promise<DirectiveRecord | undefined>;
  list(filter?: DirectiveListFilter): Promise<readonly DirectiveRecord[]>;
  extend(id: string, validity: DirectiveValidity): Promise<DirectiveRecord>;
  revoke(id: string, reason: string): Promise<DirectiveRecord>;
  refreshStates(): Promise<readonly DirectiveRecord[]>;
  inForce(query: DirectiveForceQuery): Promise<readonly DirectiveRecord[]>;
}

/** The state a directive has at `now`, from its validity alone (a revoked one stays revoked). */
export function directiveStateAt(
  directive: Pick<DirectiveRecord, 'startsAt' | 'endsAt' | 'revokedAt'>,
  now: number,
): DirectiveState {
  if (directive.revokedAt !== null) return 'revoked';
  if (directive.startsAt > now) return 'scheduled';
  if (directive.endsAt !== null && directive.endsAt <= now) return 'expired';
  return 'active';
}
