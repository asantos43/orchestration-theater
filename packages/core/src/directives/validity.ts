// SPDX-License-Identifier: MPL-2.0
import {
  directiveStateAt,
  type DirectiveRecord,
  type DirectiveState,
} from '../ports/directives.js';

/**
 * The validity of a directive is a pure function of the clock (architecture 5.17): nothing here
 * reads a timer or keeps state. The daemon asks `directiveStateAt` at the moment it needs the
 * answer, and uses the helpers below to find out what happened while it was not looking.
 */

/** The part of a directive its validity depends on. */
export type DirectiveWindow = Pick<DirectiveRecord, 'startsAt' | 'endsAt' | 'revokedAt'>;

/** A change of state a directive went through between two instants. */
export interface DirectiveTransition {
  readonly directiveId: string;
  readonly from: DirectiveState;
  readonly to: DirectiveState;
  /** The instant the change really happened (the boundary), not when it was noticed. */
  readonly effectiveAt: number;
}

/**
 * The transitions the clock caused in a directive in the window `(from, to]`, in order. A
 * boundary after a revocation is not reported (the revocation is its own event); a directive
 * that crossed both of its boundaries yields two, each with the real boundary time. A moment
 * exactly at `from` was already seen by the caller, so it is not reported again.
 *
 * This is what the daemon emits after a restart: `to` is the start-up time and `from` the last
 * time it looked, so a directive that expired while it was stopped still gets its `expired`
 * event with the true `effectiveAt`.
 */
export function directiveTransitions(
  directive: Pick<DirectiveRecord, 'id' | 'startsAt' | 'endsAt' | 'revokedAt'>,
  from: number,
  to: number,
): readonly DirectiveTransition[] {
  if (to <= from) return [];
  const cut = directive.revokedAt ?? Number.POSITIVE_INFINITY;
  const out: DirectiveTransition[] = [];
  const { startsAt, endsAt } = directive;
  if (startsAt > from && startsAt <= to && startsAt < cut) {
    out.push({ directiveId: directive.id, from: 'scheduled', to: 'active', effectiveAt: startsAt });
  }
  if (endsAt !== null && endsAt > from && endsAt <= to && endsAt < cut) {
    out.push({ directiveId: directive.id, from: 'active', to: 'expired', effectiveAt: endsAt });
  }
  return out;
}

/**
 * The instant the "ends soon" notice is due: `noticeMs` before the end, but never before the
 * start. `undefined` for a directive with no end.
 */
export function expiringNoticeAt(
  directive: Pick<DirectiveRecord, 'startsAt' | 'endsAt'>,
  noticeMs: number,
): number | undefined {
  if (directive.endsAt === null) return undefined;
  return Math.max(directive.startsAt, directive.endsAt - noticeMs);
}

/** The next instant, after `now`, at which the state of the directive changes by itself. */
export function nextBoundary(directive: DirectiveWindow, now: number): number | undefined {
  if (directive.revokedAt !== null) return undefined;
  if (directive.startsAt > now) return directive.startsAt;
  if (directive.endsAt !== null && directive.endsAt > now) return directive.endsAt;
  return undefined;
}

/** True when the directive is `active` at `now` (the clock decides). */
export function isDirectiveActive(directive: DirectiveWindow, now: number): boolean {
  return directiveStateAt(directive, now) === 'active';
}

/** True when two validities share at least one instant (the end is exclusive; null is forever). */
export function validitiesOverlap(
  a: Pick<DirectiveRecord, 'startsAt' | 'endsAt'>,
  b: Pick<DirectiveRecord, 'startsAt' | 'endsAt'>,
): boolean {
  const aEndsAfterBStarts = a.endsAt === null || a.endsAt > b.startsAt;
  const bEndsAfterAStarts = b.endsAt === null || b.endsAt > a.startsAt;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

function wallParts(at: number, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(at))) out[part.type] = part.value;
  return out;
}

/** True when the runtime knows `timezone` (an IANA name such as `America/Sao_Paulo`). */
export function isKnownTimezone(timezone: string): boolean {
  try {
    wallParts(0, timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats `at` (epoch ms) as `YYYY-MM-DD HH:mm` in `timezone`, the way an order shows its end in
 * the prompt. An unknown time zone falls back to UTC, so a stored name the runtime does not know
 * never breaks the prefix.
 */
export function formatInTimezone(at: number, timezone: string): string {
  const zone = isKnownTimezone(timezone) ? timezone : 'UTC';
  const p = wallParts(at, zone);
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''} ${p.hour ?? ''}:${p.minute ?? ''}`;
}

/** A wall-clock time with no zone attached. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Epoch ms of a wall-clock time in `timezone`: a UTC guess corrected by the zone offset at that
 * instant, twice, so it also holds across a DST edge. Used to read the `--from` and `--until` of
 * `ot directives` in the time zone of the directive.
 */
export function zonedTimeToEpoch(wall: WallTime, timezone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetAt = (instant: number): number => {
    const p = wallParts(instant, timezone);
    const shown = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
    return shown - Math.floor(instant / 60_000) * 60_000;
  };
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Reads the start or the end of a validity as written by the Producer or the Director.
 * [proposta] Accepted: `YYYY-MM-DD` (00:00 of that day), `YYYY-MM-DD HH:mm` or
 * `YYYY-MM-DDTHH:mm[:ss]`, all read as wall time in `timezone`, and the same with `Z` or an
 * offset (`-03:00`), which then wins over `timezone`. Anything else, or a date that does not
 * exist (`2026-02-30`), gives `undefined`.
 */
export function parseDirectiveInstant(text: string, timezone: string): number | undefined {
  const match = INSTANT_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00', zone] = match;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  };
  const second = Number(s);
  if (wall.month < 1 || wall.month > 12 || wall.hour > 23 || wall.minute > 59 || second > 59) {
    return undefined;
  }
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (check.getUTCMonth() !== wall.month - 1 || check.getUTCDate() !== wall.day) return undefined;
  if (zone === undefined) {
    if (!isKnownTimezone(timezone)) return undefined;
    return zonedTimeToEpoch(wall, timezone) + second * 1000;
  }
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, second);
  if (zone === 'Z') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offsetMs = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  return utc - sign * offsetMs;
}
