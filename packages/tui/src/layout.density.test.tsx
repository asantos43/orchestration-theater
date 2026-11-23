// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import type { UiDensity } from '@otheater/protocol';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from './ink.test-support.js';
import { fakeOnline, seedStores, settingsWith } from './layout.test-support.js';

/**
 * `ui.tuiLayout.density` (N258). `comfortable` is the screen of the mockup: a column of margin
 * inside each frame, the glyphs of the rail one column in, the sections of the panel apart and the
 * line of hints of the chat always reserved. `compact` is the screen as it was before, with the
 * content touching the border. The clicks over the margin are in `mouse/mouse.integration.test.tsx`.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };

async function open(density: UiDensity): Promise<RenderedApp> {
  const online = fakeOnline();
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    settings: { ...TEST_UI_SETTINGS, tuiLayout: settingsWith({ density }).tuiLayout },
    size: SIZE,
  });
  await app.waitForText('127.0.0.1');
  return app;
}

function rows(app: RenderedApp): string[] {
  return app.frame().split('\n');
}

/** The cells of a row, cut at the three areas of a 140-column screen: side bar 30, chat 60, panel 50. */
function areas(row: string | undefined): { side: string; chat: string; panel: string } {
  const cells = Array.from(row ?? '');
  return {
    side: cells.slice(0, 30).join(''),
    chat: cells.slice(30, 90).join(''),
    panel: cells.slice(90).join(''),
  };
}

function panelRows(lines: readonly string[]): string[] {
  return lines.map((line) => areas(line).panel);
}

describe('comfortable: the margins of the mockup', () => {
  it('moves the header text one column in and leaves a cell of margin on the daemon', async () => {
    const comfortable = rows(await open('comfortable'))[0] ?? '';
    cleanupApps();
    const compact = rows(await open('compact'))[0] ?? '';
    expect(comfortable.startsWith('  ◆ ot │')).toBe(true);
    expect(compact.startsWith(' ◆ ot │')).toBe(true);
    // The row of the daemon is cut at the last glyph, so the margin shows as the lead being longer
    // and the dot being one column further left.
    const dot = (line: string): number => Array.from(line).lastIndexOf('●');
    expect(dot(comfortable)).toBe(dot(compact) - 1);
  });

  it('keeps the text of the three areas one column off the border', async () => {
    const first = areas(rows(await open('comfortable'))[2]);
    expect(first.side.startsWith('│ ▾ SCENARIOS')).toBe(true);
    expect(first.chat.startsWith('│ Billing API')).toBe(true);
    expect(first.panel.startsWith('│  Overview')).toBe(true);
  });

  it('draws the separators from border to border', async () => {
    const lines = rows(await open('comfortable'));
    // Under the title of the chat, and above the text box.
    expect(areas(lines[4]).chat).toBe(`│${'─'.repeat(58)}│`);
    expect(areas(lines[37]).chat).toBe(`│${'─'.repeat(58)}│`);
    // Between the scenarios and the settings line of the side bar.
    expect(areas(lines[37]).side).toBe(`│${'─'.repeat(28)}│`);
  });

  it('draws the quota bars over the whole width inside the margin', async () => {
    const lines = rows(await open('comfortable'));
    expect(areas(lines[11]).side).toBe(`│ ${'█'.repeat(16)}${'░'.repeat(10)} │`);
    expect(areas(lines[12]).side).toBe(`│ ${'━'.repeat(8)}${'─'.repeat(18)} │`);
  });

  it('starts the underline of the panel tabs with the rule and drops the blank cells of the hints', async () => {
    const lines = rows(await open('comfortable'));
    expect(areas(lines[3]).panel.startsWith('│─━')).toBe(true);
    expect(areas(lines[3]).panel.endsWith('─│')).toBe(true);
    expect(areas(lines[39]).panel.startsWith('│ ← Tabs  Enter Fold')).toBe(true);
  });

  it('puts a blank row between the sections of the panel and indents their content by 2', async () => {
    const panel = panelRows(rows(await open('comfortable')));
    const at = (title: string): number => panel.findIndex((line) => line.includes(title));
    const pipeline = at('▾ Pipeline');
    const demands = at('▾ Demands');
    expect(panel[pipeline]?.startsWith('│ ▾ Pipeline')).toBe(true);
    expect(panel[pipeline + 1]?.startsWith('│   Need: a need')).toBe(true);
    expect(panel[demands - 1]).toMatch(/^│ +│$/);
    expect(panel[demands + 1]?.startsWith('│   No demands yet.')).toBe(true);
    expect(panel[at('▾ Actors') - 1]).toMatch(/^│ +│$/);
    // The quota rows reach the margin on the right.
    const quota = panel.find((line) => line.includes('claude-main')) ?? '';
    expect(quota.startsWith('│   claude-main')).toBe(true);
    expect(quota.endsWith('7d 31% │')).toBe(true);
  });

  it('reserves the line of the footer of the Director in the chat, blank or not', async () => {
    const lines = rows(await open('comfortable'));
    expect(areas(lines[38]).chat.startsWith('│ ❯')).toBe(true);
    expect(areas(lines[39]).chat).toBe(`│${' '.repeat(58)}│`);
    expect(areas(lines[40]).chat.startsWith('╰')).toBe(true);
  });

  it('shifts the glyphs of the rail by one column', async () => {
    const app = await open('comfortable');
    app.press('\x1bs');
    await app.waitForText('»');
    const side = rows(app).map((line) => Array.from(line).slice(0, 8).join(''));
    expect(side.some((line) => line.startsWith('│ »'))).toBe(true);
    expect(side.some((line) => line.startsWith('│ B●') || line.startsWith('│ B▸'))).toBe(true);
    expect(side.some((line) => line.startsWith('│»'))).toBe(false);
  });
});

describe('compact: the screen as it was', () => {
  it('has the content touching the border in the three areas', async () => {
    const lines = rows(await open('compact'));
    const first = areas(lines[2]);
    expect(first.side.startsWith('│▾ SCENARIOS')).toBe(true);
    expect(first.chat.startsWith('│Billing API')).toBe(true);
    expect(first.panel.startsWith('│ Overview')).toBe(true);
    expect(areas(lines[3]).panel.startsWith('│━')).toBe(true);
    expect(areas(lines[11]).side).toBe(`│${'█'.repeat(16)}${'░'.repeat(10)}  │`);
  });

  it('has the sections of the panel one after the other, with no indent', async () => {
    const panel = panelRows(rows(await open('compact')));
    const pipeline = panel.findIndex((line) => line.includes('▾ Pipeline'));
    expect(panel[pipeline]?.startsWith('│▾ Pipeline')).toBe(true);
    expect(panel[pipeline + 1]?.startsWith('│Need: a need')).toBe(true);
    expect(panel.some((line) => line.startsWith('│▾ Demands'))).toBe(true);
    expect(panel.some((line) => line.startsWith('│  ←  Tabs   Enter  Fold'))).toBe(true);
  });

  it('reserves no line for the footer of the Director', async () => {
    const lines = rows(await open('compact'));
    expect(areas(lines[39]).chat.startsWith('│❯')).toBe(true);
    expect(areas(lines[40]).chat.startsWith('╰')).toBe(true);
  });
});
