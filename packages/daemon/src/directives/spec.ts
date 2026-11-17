// SPDX-License-Identifier: MPL-2.0
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_SCOPES,
  parseDirectiveInstant,
  type DirectiveRecord,
} from '@otheater/core';
import { z } from 'zod';
import { parseDuration } from '../config.js';
import { ToolFailure } from '../mcp/handlers.js';

/**
 * The validity of an order as the Producer or the Director wrote it (architecture 5.17):
 * - `from`: when it starts; absent means the moment it is confirmed;
 * - `until`: when it ends; `null` means "until revoked"; absent leaves it to `for`, or no end;
 * - `for`: a duration (`2h`, `3d`) counted from the start (for an extension, from the current end).
 * Dates are written as `parseDirectiveInstant` reads them, in the time zone of the order.
 */
export const ValidityTextSchema = z.strictObject({
  from: z.string().min(1).optional(),
  until: z.string().min(1).nullable().optional(),
  for: z.string().min(1).optional(),
});
export type ValidityText = z.infer<typeof ValidityTextSchema>;

/** The `kind` of the decision record that holds a draft. [proposta] */
export const DRAFT_DECISION_KIND = 'directive_draft';

/** What a draft is going to do once the Producer confirms it. */
export const DraftSpecSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    text: z.string().min(1),
    scope: z.enum(DIRECTIVE_SCOPES),
    scenarioId: z.string().min(1).nullable(),
    kind: z.enum(DIRECTIVE_KINDS),
    roles: z.array(z.string().min(1)),
    ruleKey: z.string().min(1).nullable(),
    ruleValue: z.json().nullable(),
    suspendsId: z.string().min(1).nullable(),
    replacesId: z.string().min(1).nullable(),
    timezone: z.string().min(1),
    validity: ValidityTextSchema,
  }),
  z.strictObject({
    action: z.literal('extend'),
    directiveId: z.string().min(1),
    validity: ValidityTextSchema,
  }),
  z.strictObject({
    action: z.literal('revoke'),
    directiveId: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type DraftSpec = z.infer<typeof DraftSpecSchema>;

/** The start and the end of a validity, in epoch ms. */
export interface ResolvedValidity {
  readonly startsAt: number;
  readonly endsAt: number | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function bad(code: string, message: string): never {
  throw new ToolFailure(code, message);
}

/** One date of a validity: a bad text is refused with a message that says what is accepted. */
function readInstant(label: string, text: string, timezone: string, endOfDay = false): number {
  let instant = parseDirectiveInstant(text, timezone);
  if (instant === undefined) {
    bad(
      'invalid_date',
      `"${text}" is not a date for "${label}" (use YYYY-MM-DD or YYYY-MM-DD HH:mm, in ${timezone}, or with an offset such as -03:00).`,
    );
  }
  if (endOfDay && DATE_ONLY.test(text.trim())) {
    // A bare date as the end covers the whole day: the end is 23:59:59 of that day (architecture
    // 5.17), one second before the first instant of the next day.
    const [y, m, d] = text.trim().split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const nextDay = parseDirectiveInstant(next, timezone);
    if (nextDay !== undefined) instant = nextDay - 1000;
  }
  return instant;
}

function readDuration(text: string): number {
  const ms = parseDuration(text);
  if (ms === undefined || ms <= 0) {
    bad('invalid_duration', `"${text}" is not a duration (use a number and a unit: 30m, 2h, 3d).`);
  }
  return ms;
}

/** Checks the text of a validity without needing the clock (a draft is refused at proposal). */
export function checkValidityText(validity: ValidityText, timezone: string): void {
  if (validity.from !== undefined) readInstant('from', validity.from, timezone);
  if (typeof validity.until === 'string') readInstant('until', validity.until, timezone, true);
  if (validity.for !== undefined) readDuration(validity.for);
  if (validity.until !== undefined && validity.for !== undefined) {
    bad('invalid_validity', 'Give "until" or "for", not both.');
  }
}

/**
 * The dates a validity means at `now`. For a new order `for` counts from the start; for an
 * extension (`current` given) the start stays unless `from` moves it, and `for` is added to the
 * current end (to the later of now and the start when there is none). [proposta]
 */
export function resolveValidity(
  validity: ValidityText,
  timezone: string,
  now: number,
  current?: Pick<DirectiveRecord, 'startsAt' | 'endsAt'>,
): ResolvedValidity {
  checkValidityText(validity, timezone);
  const startsAt =
    validity.from === undefined
      ? (current?.startsAt ?? now)
      : readInstant('from', validity.from, timezone);
  let endsAt: number | null;
  if (validity.until === null) {
    endsAt = null;
  } else if (typeof validity.until === 'string') {
    endsAt = readInstant('until', validity.until, timezone, true);
  } else if (validity.for !== undefined) {
    const base = current === undefined ? startsAt : (current.endsAt ?? Math.max(now, startsAt));
    endsAt = base + readDuration(validity.for);
  } else {
    endsAt = current === undefined ? null : current.endsAt;
  }
  if (endsAt !== null && endsAt <= startsAt) {
    bad('invalid_validity', 'The end of the validity must be after its start.');
  }
  return { startsAt, endsAt };
}
