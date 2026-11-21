// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import { API_ROUTES, type LayoutPreferences } from '@otheater/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import {
  fakeOnline,
  MemoryLayoutFile,
  seedStores,
  type FakeOnline,
} from '../../layout.test-support.js';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '../../settings.js';
import { type UsageSectionName } from '../settings.js';
import { formatDuration } from './panels-model.js';
import {
  analysis,
  defaultWindow,
  playSpans,
  reads,
  span,
  stubPanels,
  telemetryStatus,
  type PanelsStub,
} from './usage-panels.test-support.js';

/**
 * The telemetry panels of the Usage tab (Phase 8, P10) over `ink-testing-library` and a fake
 * daemon that is online (N57): the trend per day with a day that is a gap and a figure that is a
 * dash, the bottlenecks with coverage and origin, the span tree of the followed play, the state of
 * the telemetry, the sections and their order (`ui.usage.sections`), and how many reads the tab
 * makes (the N37 budget: one per source when it opens and on each refresh, none for a section that
 * is left out). The routes are the client's stubs: the real ones are in the end-to-end test.
 */

afterEach(() => {
  cleanupApps();
  vi.restoreAllMocks();
});

const SIZE = { columns: 230, rows: 60 };

function prefs(): string {
  const base: LayoutPreferences = {
    version: 1,
    sidebarCollapsed: false,
    chatWidth: 56,
    openTabs: ['usage'],
    collapsedSections: [],
  };
  return JSON.stringify(base);
}

function online(): FakeOnline {
  const file = new MemoryLayoutFile();
  file.text = prefs();
  return fakeOnline({ file });
}

/** The tab with only these sections, in this order (the other settings are the defaults). */
function only(
  sections: readonly UsageSectionName[],
  extra: Partial<UiSettings['usage']> = {},
): UiSettings {
  return {
    ...DEFAULT_UI_SETTINGS,
    usage: { ...DEFAULT_UI_SETTINGS.usage, sections, ...extra },
  };
}

async function open(
  fake: FakeOnline,
  settings: UiSettings,
  systemLocale = 'en_US.UTF-8',
): Promise<RenderedApp> {
  return renderApp({ connector: fake.connector, size: SIZE, settings, systemLocale });
}

async function focusPanel(app: RenderedApp): Promise<void> {
  app.press('\t');
  await app.settle();
  app.press('\t');
  await app.waitForText(/Side bar\s+←\s+Tabs/);
}

/** The id of the play the tab follows: a scenario with a play, in the stores of the fake daemon. */
function followPlay(fake: FakeOnline): string {
  seedStores(fake.stores);
  const [id] = Object.keys(fake.stores.plays.getState().byId);
  if (id === undefined) throw new Error('no play was seeded');
  return id;
}

describe('the trend', () => {
  it('draws a row per day, a gap day as no data and an unknown cost as a dash, never a zero', async () => {
    const fake = online();
    const { report, gapDay, unknownCostDay } = analysis();
    const stub = stubPanels(fake, undefined, { analysis: () => Promise.resolve(report) });
    const app = await open(fake, only(['trend']));
    const frame = await app.waitForText('Trend · 14 days');
    const window = defaultWindow();
    expect(frame).toContain(window.from);
    expect(frame).toContain(window.to);
    expect(frame).toContain(`${gapDay}  no data`);
    expect(frame).toMatch(new RegExp(`${unknownCostDay}\\s+in 12.5k · out 3400 · — ≈—`));
    expect(frame).toContain('in 12.5k · out 3400 · US$ 1.50 ≈US$ 4.25');
    expect(frame).toContain('Per day: tokens, real cost');
    expect(frame).toContain('Total  in 150.0k · out 40.0k · US$ 12.50 ≈US$ 31.75');
    expect(frame).toContain('Known: tokens in 90% of the turns · cost in 50%');
    expect(frame).toContain(`closed through ${window.to}`);
    expect(frame).toContain('1 day of the period has no aggregate');
    // One read of the aggregates, by day, over the window of the tab.
    expect(stub.calls.find((c) => c.id === 'getAnalysis')?.input).toEqual({
      from: window.from,
      to: window.to,
      groupBy: 'day',
    });
  });

  it('keeps the figures of a day in a tab of 62 columns (the right pane of a 150-column terminal)', async () => {
    const fake = online();
    stubPanels(fake);
    const app = await renderApp({
      connector: fake.connector,
      size: { columns: 150, rows: 60 },
      settings: only(['trend']),
    });
    const frame = await app.waitForText('Trend · 14 days');
    await waitFor(() => app.frame().includes('Total'), 'the rows');
    expect(frame).toContain('US$ 1.50 ≈US$ 4.25');
  });

  it('says that no day is closed yet, with the aggregates empty', async () => {
    const fake = online();
    const { report } = analysis();
    stubPanels(fake, undefined, {
      analysis: () => Promise.resolve({ ...report, readyThrough: null, groups: [] }),
    });
    const app = await open(fake, only(['trend']));
    await app.waitForText('No day is closed yet');
  });

  it('follows ui.usage.trendDays', async () => {
    const fake = online();
    const stub = stubPanels(fake, undefined, {
      analysis: () => Promise.resolve(analysis(defaultWindow(7)).report),
    });
    const app = await open(fake, only(['trend'], { trendDays: 7 }));
    await app.waitForText('Trend · 7 days');
    expect(stub.calls.find((c) => c.id === 'getAnalysis')?.input).toMatchObject(defaultWindow(7));
  });

  it('keeps the rows on screen when a later read fails, and says why', async () => {
    const fake = online();
    let fail = false;
    const { report } = analysis();
    stubPanels(fake, undefined, {
      analysis: () =>
        fail
          ? Promise.reject(
              new ApiRequestError({ status: 503, body: { code: 'unavailable', message: 'busy' } }),
            )
          : Promise.resolve(report),
    });
    const app = await open(fake, only(['trend']));
    await app.waitForText('Total  in 150.0k');
    fail = true;
    await focusPanel(app);
    app.press('L');
    const frame = await app.waitForText('The daemon cannot answer now.');
    expect(frame).toContain('Total  in 150.0k');
  });
});

describe('the bottlenecks', () => {
  it('lists the states and the waits with their times, the coverage and the origin', async () => {
    const fake = online();
    stubPanels(fake);
    const app = await open(fake, only(['bottlenecks']));
    const frame = await app.waitForText('Bottlenecks');
    await waitFor(() => app.frame().includes('WRITING'), 'the stages');
    const shown = app.frame();
    expect(frame).toContain('Time per state');
    expect(shown).toContain(
      `WRITING  ${formatDuration(120_000)} · 4x · p95 ${formatDuration(45_000)} · 50%`,
    );
    // A p95 no span measured is a dash.
    expect(shown).toMatch(/REVIEW\s+\S+ · 3x · p95 — · 25%/);
    expect(shown).toContain('Waits');
    expect(shown).toMatch(/quota\s+\S+ · 2x · p95 \S+ · 13%/);
    expect(shown).toContain('attempts with client telemetry 67% · tokens 90% · cost 50%');
    expect(shown).toContain('Origin of the numbers: daemon, otlp');
    expect(shown).toContain('p95 is approximate');
  });

  it('says that nothing was measured, and shows an unknown coverage as a dash', async () => {
    const fake = online();
    const { report } = analysis();
    stubPanels(fake, undefined, {
      analysis: () =>
        Promise.resolve({
          ...report,
          percentilesApproximate: false,
          period: {
            ...report.period,
            bottlenecks: [],
            summary: {
              ...report.period.summary,
              coverage: {
                ...report.period.summary.coverage,
                attemptCoverage: null,
                tokenCoverage: null,
                costCoverage: null,
                origins: [],
              },
            },
          },
        }),
    });
    const app = await open(fake, only(['bottlenecks']));
    await waitFor(() => app.frame().includes('Nothing measured in this period.'), 'the empty list');
    const frame = app.frame();
    expect(frame).toContain('client telemetry — · tokens — · cost —');
    expect(frame).toContain('Origin of the numbers: —');
    expect(frame).not.toContain('p95 is approximate');
  });

  it('shares the one read of the aggregates with the trend', async () => {
    const fake = online();
    const stub = stubPanels(fake);
    const app = await open(fake, only(['trend', 'bottlenecks']));
    await waitFor(() => app.frame().includes('WRITING'), 'both sections');
    expect(app.frame()).toContain('Trend · 14 days');
    expect(reads(stub, 'getAnalysis')).toBe(1);
  });
});

describe('the spans of the play', () => {
  it('draws the tree of the play the Trajectories tab follows, with the durations', async () => {
    const fake = online();
    const id = followPlay(fake);
    const stub = stubPanels(fake);
    const app = await open(fake, only(['play']));
    const frame = await app.waitForText('Spans of the play');
    await waitFor(() => app.frame().includes('write_file'), 'the tree');
    const shown = app.frame();
    expect(frame).toContain(id);
    expect(shown).toMatch(/play\s+2m05s/);
    expect(shown).toMatch(/ {2}stage WRITING\s+1m02s/);
    expect(shown).toContain('attempt author (fake/one)');
    expect(shown).toMatch(/tool write_file\s+failed 250ms/);
    // Children are indented under their parent.
    expect(shown.indexOf('stage WRITING')).toBeLessThan(shown.indexOf('attempt author'));
    expect(shown).not.toContain('The play is running');
    expect(stub.calls.find((c) => c.id === 'getPlaySpans')?.input).toEqual({
      params: { playId: id },
      query: { limit: 1000 },
    });
  });

  it('lists ui.usage.spanRows spans and counts the rest', async () => {
    const fake = online();
    followPlay(fake);
    stubPanels(fake);
    const app = await open(fake, only(['play'], { spanRows: 5 }));
    // The tree has four spans: the count of what is hidden shows when the rows are fewer.
    await waitFor(() => app.frame().includes('write_file'), 'the tree');
    expect(app.frame()).not.toContain('more spans');
  });

  it('counts the spans past the rows, and says the play is still running', async () => {
    const fake = online();
    followPlay(fake);
    stubPanels(fake, undefined, {
      spans: () =>
        Promise.resolve({
          ...playSpans({ playClosed: false, truncated: true }),
          spans: Array.from({ length: 8 }, (_, i) =>
            span(`s${String(i)}`, { label: `ST${String(i)}` }),
          ),
        }),
    });
    const app = await open(fake, only(['play'], { spanRows: 5 }));
    await waitFor(() => app.frame().includes('ST0'), 'the tree');
    const frame = app.frame();
    expect(frame).toContain('ST4');
    expect(frame).not.toContain('ST5');
    expect(frame).toContain('... 3 more spans (ui.usage.spanRows)');
    expect(frame).toContain('The play is running');
    expect(frame).toContain('The base has more spans than were read');
  });

  it('says so when there is no scenario or the scenario has no play, and reads nothing', async () => {
    const fake = online();
    const stub = stubPanels(fake);
    const app = await open(fake, only(['play']));
    await app.waitForText('Select a scenario to see the spans of its play.');
    expect(reads(stub, 'getPlaySpans')).toBe(0);

    const second = online();
    seedStores(second.stores);
    second.stores.plays.setState({ byId: {} } as never);
    const other = stubPanels(second);
    const again = await open(second, only(['play']));
    await again.waitForText('This scenario has no play yet.');
    expect(reads(other, 'getPlaySpans')).toBe(0);
  });

  it('says that a play with no span yet is empty', async () => {
    const fake = online();
    followPlay(fake);
    stubPanels(fake, undefined, {
      spans: () => Promise.resolve(playSpans({ spans: [], playClosed: false })),
    });
    const app = await open(fake, only(['play']));
    await app.waitForText('No span of this play yet.');
  });
});

describe('the state of the telemetry', () => {
  it('shows the receiver, the refused batches, the base and the export with its drops', async () => {
    const fake = online();
    stubPanels(fake);
    const app = await open(fake, only(['telemetry']));
    await app.waitForText('Receiver listening on port 4318.');
    const frame = app.frame();
    expect(frame).toContain('Batches taken: traces 12 · metrics 3 · logs 0');
    expect(frame).toContain('Batches refused: format 1 · size 0 · token 2');
    expect(frame).toContain('Spans of the daemon: on');
    expect(frame).toContain('Base ok · written 345 · queued 0');
    expect(frame).toContain('Export: OTLP and Prometheus');
    expect(frame).toContain('OTLP to http://127.0.0.1:4317 · sent 77');
    expect(frame).toContain('2 records dropped after the retries: network 2');
    expect(frame).toContain('Prometheus metrics served at /metrics');
  });

  it.each([
    ['off', 'Telemetry is off (telemetry.enabled).'],
    ['no_base', 'The telemetry base is not open: nothing is kept.'],
    ['no_receiver', 'the OTLP receiver could not listen'],
  ] as const)('says why there is no receiver (%s)', async (state, text) => {
    const fake = online();
    stubPanels(fake, undefined, {
      telemetry: () =>
        Promise.resolve(
          telemetryStatus({
            state,
            receiver: null,
            base: state === 'no_base' ? null : telemetryStatus().base,
            export: { mode: 'off', otlp: null, prometheus: false },
          }),
        ),
    });
    const app = await open(fake, only(['telemetry']));
    const frame = await app.waitForText(text);
    expect(frame).not.toContain('Batches taken');
    expect(frame).toContain('Export: off');
    expect(frame).not.toContain('Prometheus metrics served');
  });
});

describe('the sections and the reads', () => {
  it('draws the sections of ui.usage.sections in that order, and only those', async () => {
    const fake = online();
    stubPanels(fake);
    const app = await open(fake, only(['telemetry', 'bottlenecks']));
    await waitFor(() => app.frame().includes('WRITING'), 'the sections');
    const frame = app.frame();
    expect(frame.indexOf('Telemetry')).toBeGreaterThan(-1);
    expect(frame.indexOf('Telemetry')).toBeLessThan(frame.indexOf('Bottlenecks'));
    expect(frame).not.toContain('Totals');
    expect(frame).not.toContain('Trend');
    expect(frame).not.toContain('Spans of the play');
  });

  it('reads once per source when it opens and once more on the refresh key (N37)', async () => {
    const fake = online();
    followPlay(fake);
    const stub = stubPanels(fake);
    const app = await open(fake, DEFAULT_UI_SETTINGS);
    await waitFor(
      () =>
        reads(stub, 'getAnalysis') === 1 &&
        reads(stub, 'getPlaySpans') === 1 &&
        reads(stub, 'getTelemetryStatus') === 1,
      'the first reads',
    );
    // A pause: a render that is not a refresh reads nothing more.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads(stub, 'getAnalysis')).toBe(1);
    await focusPanel(app);
    app.press('L');
    await waitFor(
      () =>
        reads(stub, 'getAnalysis') === 2 &&
        reads(stub, 'getPlaySpans') === 2 &&
        reads(stub, 'getTelemetryStatus') === 2,
      'the refresh',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.calls.filter((c) => c.id !== 'getUsage' && c.id !== 'getBudget')).toHaveLength(6);
  });

  it('does not read a source whose section is left out', async () => {
    const fake = online();
    followPlay(fake);
    const usageReads: unknown[] = [];
    const stub: PanelsStub = stubPanels(fake, (route) => {
      if (route === API_ROUTES.getUsage || route === API_ROUTES.getBudget) usageReads.push(route);
      return undefined;
    });
    const app = await open(fake, only(['telemetry']));
    await app.waitForText('Receiver listening on port 4318.');
    // Nor the totals and the budget, when none of their three sections is drawn.
    expect(usageReads).toEqual([]);
    expect(app.frame()).not.toContain('Reading consumption');
    expect(reads(stub, 'getTelemetryStatus')).toBe(1);
    expect(reads(stub, 'getAnalysis')).toBe(0);
    expect(reads(stub, 'getPlaySpans')).toBe(0);
  });

  it('reads on its own every ui.usage.refreshSeconds', async () => {
    const fake = online();
    const stub = stubPanels(fake);
    await open(fake, only(['telemetry'], { refreshSeconds: 1 }));
    await waitFor(() => reads(stub, 'getTelemetryStatus') >= 2, 'the timed read', 4000);
  });
});

describe('in Portuguese', () => {
  it('draws the four sections with the catalog of pt-BR', async () => {
    const fake = online();
    followPlay(fake);
    stubPanels(fake);
    const app = await open(
      fake,
      only(['trend', 'bottlenecks', 'play', 'telemetry'], { trendDays: 3 }),
      'pt_BR.UTF-8',
    );
    await waitFor(() => app.frame().includes('write_file'), 'the sections');
    await waitFor(() => app.frame().includes('Receptor ouvindo'), 'the telemetry');
    const frame = app.frame();
    expect(frame).toContain('Tendência · 3 dias');
    expect(frame).toContain('Gargalos');
    expect(frame).toContain('Tempo por estado');
    expect(frame).toContain('Origem dos números: daemon, otlp');
    expect(frame).toContain('Spans da peça');
    expect(frame).toMatch(/etapa WRITING/);
    expect(frame).toMatch(/ferramenta write_file\s+falhou 250ms/);
    expect(frame).toContain('Telemetria');
    expect(frame).toContain('Lotes recusados: formato 1 · tamanho 0 · token 2');
    expect(frame).toContain('2 registros descartados após as tentativas: network 2');
  });
});
