// SPDX-License-Identifier: MPL-2.0
import type { ApiOrder } from '@otheater/protocol';
import { KEYS, type RenderedApp } from '../../ink.test-support.js';

/** What the tests of the tab Directives share: an order as the client store keeps it, and the way to open the tab. */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** An order with the defaults of an instruction that is in force; `now` is the moment the test is at. */
export function order(id: string, extra: Partial<ApiOrder> = {}, now = Date.now()): ApiOrder {
  return {
    id,
    seq: Number(id.slice(1)),
    scope: 'global',
    scenarioId: null,
    kind: 'instruction',
    text: `Order ${id}`,
    ruleKey: null,
    ruleValue: null,
    suspendsId: null,
    roles: [],
    startsAt: now - HOUR,
    endsAt: null,
    timezone: 'America/Sao_Paulo',
    state: 'active',
    origin: 'tui',
    replacesId: null,
    createdAt: now - HOUR,
    updatedAt: now - HOUR,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  };
}

/** The words of the screen the helper waits for, in the language of the test. */
export interface TabWords {
  readonly palette: string;
  readonly tab: string;
  readonly section: string;
}
const ENGLISH: TabWords = { palette: 'Command palette', tab: 'Directives', section: 'In force' };

/** Opens the tab through the palette (the tab has no key of its own), and waits for it to draw. */
export async function openDirectivesTab(
  app: RenderedApp,
  words: TabWords = ENGLISH,
): Promise<string> {
  app.press('\x1bk');
  await app.waitForText(words.palette);
  app.press(words.tab);
  await app.waitForText(words.tab);
  app.press(KEYS.enter);
  return app.waitForText(words.section);
}
