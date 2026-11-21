// SPDX-License-Identifier: MPL-2.0
import type { ApiOrder } from '@otheater/protocol';

/**
 * What the tab Directives draws, worked out from the orders of the client store. Pure: the orders,
 * the names of the scenarios and the moment in, rows and text out. The state of an order is the
 * one the store keeps (the events `directive.*` move it), never recomputed from the clock here.
 */

/** The three sections of the tab, top to bottom. */
export const ORDER_SECTIONS = ['inForce', 'scheduled', 'ended'] as const;
export type OrderSection = (typeof ORDER_SECTIONS)[number];

export function sectionOf(order: Pick<ApiOrder, 'state'>): OrderSection {
  switch (order.state) {
    case 'active':
      return 'inForce';
    case 'scheduled':
      return 'scheduled';
    default:
      return 'ended';
  }
}

/** The id of the section in the layout (`LayoutStore` keeps what is folded); it names the tab. */
export function sectionId(section: OrderSection): string {
  return `directives.${section}`;
}

export const SECTION_IDS: readonly string[] = ORDER_SECTIONS.map(sectionId);

/** A group of orders under one heading: the global ones, or the ones of one scenario. */
export interface OrderGroup {
  /** `null` for the global orders. */
  readonly scenarioId: string | null;
  readonly orders: readonly ApiOrder[];
}

export interface OrderSections {
  readonly inForce: readonly OrderGroup[];
  readonly scheduled: readonly OrderGroup[];
  readonly ended: readonly OrderGroup[];
}

/**
 * The orders by section and, inside it, by scope: the global ones first, then one group per
 * scenario (by the name of the scenario). Inside a group the order is the order they were given
 * (`seq`); the ended ones come the other way round, the latest first, because that is what the
 * person looks for.
 */
export function groupOrders(
  orders: readonly ApiOrder[],
  scenarioName: (id: string) => string,
): OrderSections {
  const result: Record<OrderSection, Map<string | null, ApiOrder[]>> = {
    inForce: new Map(),
    scheduled: new Map(),
    ended: new Map(),
  };
  for (const order of [...orders].sort((a, b) => a.seq - b.seq)) {
    const key = order.scope === 'global' ? null : order.scenarioId;
    const bucket = result[sectionOf(order)];
    const list = bucket.get(key);
    if (list === undefined) bucket.set(key, [order]);
    else list.push(order);
  }
  const build = (section: OrderSection): OrderGroup[] =>
    [...result[section].entries()]
      .sort(([a], [b]) => {
        if (a === b) return 0;
        if (a === null) return -1;
        if (b === null) return 1;
        return scenarioName(a).localeCompare(scenarioName(b)) || a.localeCompare(b);
      })
      .map(([scenarioId, list]) => ({
        scenarioId,
        orders: section === 'ended' ? [...list].reverse() : list,
      }));
  return {
    inForce: build('inForce'),
    scheduled: build('scheduled'),
    ended: build('ended'),
  };
}

/** The ids of the orders in the order they are on the screen, skipping the sections that are folded. */
export function visibleOrderIds(
  sections: OrderSections,
  folded: ReadonlySet<string>,
): readonly string[] {
  const ids: string[] = [];
  for (const section of ORDER_SECTIONS) {
    if (folded.has(sectionId(section))) continue;
    for (const group of sections[section]) for (const order of group.orders) ids.push(order.id);
  }
  return ids;
}

/** `2d 3h`, `5h 10m`, `42m`, `<1m`: a span in the two largest units, the same in every language. */
export function spanText(ms: number): string {
  const span = Math.max(0, ms);
  const minutes = Math.floor(span / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const unit = (value: number, name: string): string => `${String(value)}${name}`;
  if (days > 0) return hours > 0 ? `${unit(days, 'd')} ${unit(hours, 'h')}` : unit(days, 'd');
  if (hours > 0) return rest > 0 ? `${unit(hours, 'h')} ${unit(rest, 'm')}` : unit(hours, 'h');
  return unit(rest, 'm');
}

/** `2026-11-21 09:30` in the time zone of the order (UTC when the zone is not one the runtime knows). */
export function dateText(ms: number, timeZone: string): string {
  const parts = (zone: string): Record<string, string> => {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  };
  let got: Record<string, string | undefined>;
  try {
    got = parts(timeZone);
  } catch {
    got = parts('UTC');
  }
  const at = (part: string): string => got[part] ?? '';
  return `${at('year')}-${at('month')}-${at('day')} ${at('hour')}:${at('minute')}`;
}

/**
 * The bar of the validity, `cells` wide: filled up to where `now` is between the start and the
 * end; empty before the start; full after the end. With no end it is a line that goes on (`→`).
 */
export function timelineBar(
  order: Pick<ApiOrder, 'startsAt' | 'endsAt' | 'state'>,
  now: number,
  cells: number,
): string {
  const size = Math.max(1, cells);
  if (order.endsAt === null) {
    const line = '━'.repeat(Math.max(0, size - 1)) + '→';
    return order.state === 'scheduled' ? line.replaceAll('━', '░') : line;
  }
  const length = Math.max(1, order.endsAt - order.startsAt);
  const ratio =
    order.state === 'expired' || order.state === 'revoked'
      ? 1
      : Math.min(1, Math.max(0, (now - order.startsAt) / length));
  const filled = Math.round(size * ratio);
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

/** Where an order stands against the clock, for the line of deadlines; the words come from the catalog. */
export type Deadline =
  | { readonly kind: 'endsIn'; readonly span: string }
  | { readonly kind: 'untilRevoked' }
  | { readonly kind: 'startsIn'; readonly span: string }
  | { readonly kind: 'endedAgo'; readonly span: string }
  | { readonly kind: 'revokedAgo'; readonly span: string };

export function deadlineOf(
  order: Pick<ApiOrder, 'state' | 'startsAt' | 'endsAt' | 'revokedAt'>,
  now: number,
): Deadline {
  switch (order.state) {
    case 'scheduled':
      return { kind: 'startsIn', span: spanText(order.startsAt - now) };
    case 'expired':
      return { kind: 'endedAgo', span: spanText(now - (order.endsAt ?? now)) };
    case 'revoked':
      return { kind: 'revokedAgo', span: spanText(now - (order.revokedAt ?? now)) };
    default:
      return order.endsAt === null
        ? { kind: 'untilRevoked' }
        : { kind: 'endsIn', span: spanText(order.endsAt - now) };
  }
}

/** The first line of the text of an order, for the row. */
export function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}
