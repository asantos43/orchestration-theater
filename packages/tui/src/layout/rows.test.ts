// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { frameLine } from './frame.js';
import { fillBar, finishedRows, quotaRows, scenarioRows } from './scenario-rows.js';
import { sidebarItems, SIDEBAR_SECTIONS } from './sidebar.js';
import { play, quota, scenario } from '../layout.test-support.js';
import { cellWidth } from './text.js';

describe('scenarioRows', () => {
  it('marks a decision over a running play, a running play over a finished one, and lists the active ones, latest first', () => {
    const waiting = scenario('Mobile app', { updatedAt: 30 });
    const running = scenario('Billing API', { updatedAt: 20 });
    const done = scenario('Docs site', { updatedAt: 10 });
    const idle = scenario('Idle one', { updatedAt: 5 });
    const archived = scenario('Old one', { state: 'archived', updatedAt: 99 });
    const rows = scenarioRows(
      Object.fromEntries([waiting, running, done, idle, archived].map((item) => [item.id, item])),
      Object.fromEntries(
        [
          play(waiting.id),
          play(running.id),
          play(done.id, { state: 'DONE', finishedAt: 5, updatedAt: 7 }),
        ].map((item) => [item.id, item]),
      ),
      { [waiting.id]: [{}] },
    );
    expect(rows.map((row) => [row.name, row.mark])).toEqual([
      ['Mobile app', 'decision'],
      ['Billing API', 'running'],
      ['Docs site', 'done'],
      ['Idle one', 'idle'],
    ]);
  });
});

describe('quotaRows and fillBar', () => {
  it('reads the two windows by name and clamps the percent', () => {
    const rows = quotaRows({
      b: quota('b', 120, undefined),
      a: quota('a', 62.4, 31),
    });
    expect(rows.map((row) => [row.profile, row.fiveHour, row.week])).toEqual([
      ['a', 62, 31],
      ['b', 100, undefined],
    ]);
  });

  it('fills a bar to the percent, never beyond the cells', () => {
    expect(fillBar(10, 0)).toBe('░'.repeat(10));
    expect(fillBar(10, 50)).toBe('█'.repeat(5) + '░'.repeat(5));
    expect(fillBar(10, 100)).toBe('█'.repeat(10));
    expect(fillBar(10, 250)).toBe('█'.repeat(10));
  });
});

describe('sidebarItems', () => {
  const rows = [
    { id: 'S1', name: 'One', mark: 'idle' as const },
    { id: 'S2', name: 'Two', mark: 'idle' as const },
  ];

  it('walks the two section headers and the scenarios between them', () => {
    expect(sidebarItems(rows, new Set(), 'expanded')).toEqual([
      { kind: 'section', id: SIDEBAR_SECTIONS.scenarios },
      { kind: 'scenario', id: 'S1' },
      { kind: 'scenario', id: 'S2' },
      { kind: 'section', id: SIDEBAR_SECTIONS.subscriptions },
    ]);
  });

  it('hides the scenarios of a folded section, and the rail has only scenarios', () => {
    expect(
      sidebarItems(rows, new Set([SIDEBAR_SECTIONS.scenarios]), 'expanded').map((item) => item.id),
    ).toEqual([SIDEBAR_SECTIONS.scenarios, SIDEBAR_SECTIONS.subscriptions]);
    expect(sidebarItems(rows, new Set(), 'rail').map((item) => item.id)).toEqual(['S1', 'S2']);
    expect(sidebarItems(rows, new Set([SIDEBAR_SECTIONS.scenarios]), 'rail')).toEqual([]);
  });

  it('puts the finished section between the scenarios and the subscriptions, with its plays only when open (P11)', () => {
    const finishedRow = {
      id: 'P1',
      scenarioId: 'S1',
      scenarioName: 'One',
      need: 'ship it',
      outcome: 'done' as const,
      finishedAt: 5,
    };
    expect(
      sidebarItems(rows, new Set(), 'expanded', { rows: [finishedRow], open: false }).map(
        (item) => item.id,
      ),
    ).toEqual([
      'sidebar.scenarios',
      'S1',
      'S2',
      SIDEBAR_SECTIONS.finished,
      SIDEBAR_SECTIONS.subscriptions,
    ]);
    expect(
      sidebarItems(rows, new Set(), 'expanded', { rows: [finishedRow], open: true }).slice(3, 5),
    ).toEqual([
      { kind: 'section', id: SIDEBAR_SECTIONS.finished },
      { kind: 'finished', id: 'P1', scenarioId: 'S1' },
    ]);
    // The rail never has the section.
    expect(
      sidebarItems(rows, new Set(), 'rail', { rows: [finishedRow], open: true }).map(
        (item) => item.id,
      ),
    ).toEqual(['S1', 'S2']);
  });
});

describe('finishedRows (P11)', () => {
  const index = <T extends { id: string }>(...items: T[]): Record<string, T> =>
    Object.fromEntries(items.map((item) => [item.id, item]));

  it('lists the finished plays of the active scenarios, the latest first, up to the limit', () => {
    const active = scenario('Billing API');
    const archived = scenario('Old one', { state: 'archived' });
    const older = play(active.id, { state: 'DONE', finishedAt: 10, need: 'older' });
    const newer = play(active.id, { state: 'CANCELLED', finishedAt: 30, need: 'newer' });
    const middle = play(active.id, { state: 'DONE', finishedAt: 20, need: 'middle' });
    const running = play(active.id);
    const hidden = play(archived.id, { state: 'DONE', finishedAt: 99 });
    const orphan = play('S-unknown', { state: 'DONE', finishedAt: 98 });
    const rows = finishedRows(
      index(active, archived),
      index(older, newer, middle, running, hidden, orphan),
      10,
    );
    expect(rows.map((row) => [row.need, row.outcome, row.scenarioName])).toEqual([
      ['newer', 'cancelled', 'Billing API'],
      ['middle', 'done', 'Billing API'],
      ['older', 'done', 'Billing API'],
    ]);
    expect(
      finishedRows(index(active), index(older, newer, middle), 2).map((row) => row.need),
    ).toEqual(['newer', 'middle']);
    expect(finishedRows(index(active), index(older), 0)).toEqual([]);
  });
});

describe('frameLine', () => {
  it('is always as wide as asked, with the title on the left and the label on the right', () => {
    const line = frameLine(30, ['╭', '╮'], 'Chat', 'Alt+S');
    expect(cellWidth(line)).toBe(30);
    expect(line.startsWith('╭─ Chat ')).toBe(true);
    expect(line.endsWith(' Alt+S ─╮')).toBe(true);
  });

  it('cuts the title and then the label when the room is short, and keeps its width', () => {
    for (const width of [3, 8, 14, 20]) {
      const line = frameLine(width, ['╰', '╯'], 'A long title', 'A long label');
      expect(cellWidth(line)).toBe(width);
    }
  });

  it('draws only the line when there is nothing to write on it', () => {
    expect(frameLine(8, ['╭', '╮'], undefined, undefined)).toBe('╭──────╮');
  });
});
