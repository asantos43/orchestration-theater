// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import {
  API_ROUTES,
  type ApiBudget,
  type ApiUsage,
  type ApiUsageTotals,
  type LayoutPreferences,
} from '@otheater/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import { fakeOnline, MemoryLayoutFile, type FakeOnline } from '../../layout.test-support.js';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '../../settings.js';

/**
 * The Usage tab over `ink-testing-library` and a fake daemon that is online (N57): what it draws
 * of `/v1/usage` and `/v1/budget` (stubbed on the client), the split of `ui.usage.groupBy`, the
 * refresh key and the answer to a failed read.
 */

afterEach(() => {
  cleanupApps();
  vi.restoreAllMocks();
});

const SIZE = { columns: 140, rows: 50 };

function totals(extra: Partial<ApiUsageTotals> = {}): ApiUsageTotals {
  return {
    turns: 12,
    inputTokens: 12_500,
    outputTokens: 3_400,
    cachedTokens: 1_200_000,
    realUsd: 1.5,
    apiEquivalentUsd: 4.25,
    unknownCostTurns: 0,
    complete: true,
    ...extra,
  };
}

const USAGE: ApiUsage = {
  totals: totals(),
  by: 'profile',
  groups: [
    { key: 'codex-work', totals: totals({ realUsd: 0, apiEquivalentUsd: 1 }) },
    { key: 'claude-main', totals: totals({ realUsd: 1.5, apiEquivalentUsd: 3.25 }) },
  ],
};

const BUDGET: ApiBudget = {
  timezone: 'America/Sao_Paulo',
  unknownCost: 'block',
  onCapChange: 'keep',
  caps: [
    {
      scope: 'profile',
      id: 'claude-main',
      period: 'day',
      limitUsd: 10,
      spentUsd: 2.5,
      remainingUsd: 7.5,
      endsAt: null,
      unknownCostTurns: 0,
      blockedByUnknownCost: false,
    },
  ],
  exceeded: [],
} as unknown as ApiBudget;

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

interface Stub {
  readonly calls: { id: string; query: unknown }[];
  usage: () => Promise<ApiUsage>;
}

/** Answers `getUsage` and `getBudget` of the client from the fixtures above. */
function stubCalls(fake: FakeOnline, usage: Stub['usage'] = () => Promise.resolve(USAGE)): Stub {
  const stub: Stub = { calls: [], usage };
  vi.spyOn(fake.client, 'call').mockImplementation(
    (route: unknown, input?: { query?: unknown }) => {
      if (route === API_ROUTES.getUsage) {
        stub.calls.push({ id: 'getUsage', query: input?.query });
        return stub.usage();
      }
      if (route === API_ROUTES.getBudget) {
        stub.calls.push({ id: 'getBudget', query: undefined });
        return Promise.resolve(BUDGET);
      }
      return Promise.reject(new Error('unexpected route'));
    },
  );
  return stub;
}

function withUsage(change: Partial<UiSettings['usage']>): UiSettings {
  return { ...DEFAULT_UI_SETTINGS, usage: { ...DEFAULT_UI_SETTINGS.usage, ...change } };
}

async function open(fake: FakeOnline, settings: UiSettings = DEFAULT_UI_SETTINGS) {
  return renderApp({ connector: fake.connector, size: SIZE, settings });
}

async function focusPanel(app: RenderedApp): Promise<void> {
  app.press('\t');
  await app.settle();
  app.press('\t');
  await app.waitForText(/Side bar\s+←\s+Tabs/);
}

const reads = (stub: Stub, id: string): number => stub.calls.filter((c) => c.id === id).length;

describe('what the Usage tab draws', () => {
  it('shows the totals, the groups by account and the caps of the budget', async () => {
    const fake = online();
    const stub = stubCalls(fake);
    const app = await open(fake);
    const frame = await app.waitForText('Totals');
    await waitFor(() => app.frame().includes('claude-main'), 'the groups');
    const shown = app.frame();
    expect(frame).toContain('Totals');
    expect(shown).toContain('12 turns');
    expect(shown).toContain('in 12.5k · out 3400');
    expect(shown).toContain('Real US$ 1.50');
    expect(shown).toContain('API equivalent US$ 4.25');
    expect(shown).toContain('By account');
    // Sorted by what was spent: the account with real dollars comes first.
    expect(shown.indexOf('claude-main')).toBeLessThan(shown.indexOf('codex-work'));
    expect(shown).toContain('Budget');
    expect(shown).toContain('Account claude-main · day');
    expect(shown).toContain('US$ 2.50 / US$ 10.00');
    expect(shown).toContain('25%');
    // The split asked of the daemon is the one of `ui.usage.groupBy`.
    expect(stub.calls.find((c) => c.id === 'getUsage')?.query).toEqual({ by: 'profile' });
  });

  it('does not split the totals with groupBy none, and asks with no `by`', async () => {
    const fake = online();
    const stub = stubCalls(fake);
    const app = await open(fake, withUsage({ groupBy: 'none' }));
    await app.waitForText('Not split');
    expect(stub.calls.find((c) => c.id === 'getUsage')?.query).toEqual({});
  });

  it('warns that the sums are a lower bound when some turns have no cost', async () => {
    const fake = online();
    stubCalls(fake, () =>
      Promise.resolve({
        ...USAGE,
        totals: totals({ unknownCostTurns: 2, complete: false }),
      }),
    );
    const app = await open(fake);
    await app.waitForText('2 turns of unknown cost');
  });

  it('draws the same in Portuguese', async () => {
    const fake = online();
    stubCalls(fake);
    const app = await renderApp({
      connector: fake.connector,
      size: SIZE,
      systemLocale: 'pt_BR.UTF-8',
    });
    const frame = await app.waitForText('Orçamento');
    expect(frame).toContain('Totais');
  });
});

describe('reading again', () => {
  it('reads both routes when the tab opens, and again on the refresh key', async () => {
    const fake = online();
    const stub = stubCalls(fake);
    const app = await open(fake);
    await app.waitForText('Totals');
    await waitFor(() => reads(stub, 'getUsage') === 1, 'the first read');
    expect(reads(stub, 'getBudget')).toBe(1);
    await focusPanel(app);
    app.press('L');
    await waitFor(() => reads(stub, 'getUsage') === 2, 'the second read');
    expect(reads(stub, 'getBudget')).toBe(2);
  });

  it('reads on its own every ui.usage.refreshSeconds, and not at all with 0', async () => {
    const timed = online();
    const stubTimed = stubCalls(timed);
    await open(timed, withUsage({ refreshSeconds: 1 }));
    await waitFor(() => reads(stubTimed, 'getUsage') >= 2, 'the timed read', 4000);

    const idle = online();
    const stubIdle = stubCalls(idle);
    const app = await open(idle, withUsage({ refreshSeconds: 0 }));
    await app.waitForText('Totals');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(reads(stubIdle, 'getUsage')).toBe(1);
  });

  it('keeps what it had on screen when a later read fails, and says why', async () => {
    const fake = online();
    let fail = false;
    stubCalls(fake, () =>
      fail
        ? Promise.reject(
            new ApiRequestError({
              status: 503,
              body: { code: 'unavailable', message: 'busy' },
            }),
          )
        : Promise.resolve(USAGE),
    );
    const app = await open(fake);
    await waitFor(() => app.frame().includes('claude-main'), 'the first answer');
    fail = true;
    await focusPanel(app);
    app.press('L');
    const frame = await app.waitForText('The daemon cannot answer now.');
    expect(frame).toContain('claude-main');
    expect(frame).toContain('Real US$ 1.50');
  });
});
