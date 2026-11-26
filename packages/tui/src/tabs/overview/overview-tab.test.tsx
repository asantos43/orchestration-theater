// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError, type ActorActivity, type DaemonStores } from '@otheater/client';
import {
  LAYOUT_VERSION,
  type ApiEventEnvelope,
  type ApiPlay,
  type LayoutPreferences,
} from '@otheater/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import {
  fakeOnline,
  MemoryLayoutFile,
  play as playOf,
  quota,
  scenario as scenarioOf,
  type FakeOnline,
} from '../../layout.test-support.js';
import { type UiSettings } from '../../settings.js';
import { TEST_UI_SETTINGS } from '../../ink.test-support.js';

/**
 * The Overview tab over `ink-testing-library` and a fake daemon that is online (N57): what it
 * draws from the stores of the client, the pause and resume controls with their confirmation, and
 * that a store that moves redraws it without one REST read.
 */

afterEach(() => {
  cleanupApps();
  vi.restoreAllMocks();
});

const SIZE = { columns: 140, rows: 60 };
const NOW = Date.now();

function prefs(): string {
  const base: LayoutPreferences = {
    version: LAYOUT_VERSION,
    sidebarCollapsed: false,
    chatWidth: 56,
    openTabs: ['overview'],
    collapsedSections: [],
  };
  return JSON.stringify(base);
}

function demand(
  playId: string,
  id: string,
  state: string,
  dependsOn: string[] = [],
): Record<string, unknown> {
  return {
    playId,
    id,
    title: `Demand ${id}`,
    description: '',
    dependsOn,
    state,
    timeoutMin: 30,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function event(
  id: number,
  type: string,
  playId: string,
  scenarioId: string,
  payload: Record<string, unknown> = {},
): ApiEventEnvelope {
  return {
    id,
    timestamp: NOW,
    type,
    schemaVersion: 1,
    payload,
    scenarioId,
    playId,
    daemonId: '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b',
  } as unknown as ApiEventEnvelope;
}

function actor(playId: string, extra: Partial<ActorActivity> = {}): ActorActivity {
  return {
    key: 'A1',
    sessionId: 'sess-1',
    attemptId: 'A1',
    playId,
    demandId: 'D2',
    executor: { client: 'claude', profile: 'claude-main', model: 'sonnet' },
    startedAt: NOW - 5 * 60_000,
    paused: undefined,
    ...extra,
  };
}

interface World {
  readonly online: FakeOnline;
  readonly scenarioId: string;
  readonly play: ApiPlay;
}

/** One scenario with an open play in EXECUTING, three demands, an Actor, two events and a quota. */
function world(extra: { paused?: boolean; playPaused?: boolean } = {}): World {
  const file = new MemoryLayoutFile();
  file.text = prefs();
  const online = fakeOnline({ file });
  const scenario = scenarioOf('Billing API');
  const play = playOf(scenario.id, {
    state: 'EXECUTING',
    need: 'Charge by usage',
    createdAt: NOW,
  });
  const { stores } = online;
  stores.scenarios.setState({ byId: { [scenario.id]: scenario } } as never);
  stores.plays.setState({ byId: { [play.id]: play } } as never);
  stores.demands.setState({
    byPlay: {
      [play.id]: {
        demands: [
          demand(play.id, 'D1', 'approved'),
          demand(play.id, 'D2', 'running', ['D1']),
          demand(play.id, 'D3', 'ready', ['D1']),
          demand(play.id, 'D4', 'pending', ['D2', 'D3']),
        ],
        stages: [],
      },
    },
    waiting: {},
  } as never);
  stores.activity.setState({
    actors: { A1: actor(play.id, extra.paused === true ? { paused: 'actor' } : {}) },
    pausedPlays: extra.playPaused === true ? { [play.id]: NOW } : {},
  } as never);
  stores.events.setState({
    events: [
      event(1, 'session.update', play.id, scenario.id),
      event(2, 'demand.transitioned', play.id, scenario.id, {
        playId: play.id,
        demandId: 'D2',
        from: 'ready',
        to: 'running',
      }),
    ],
  } as never);
  stores.quotas.setState({
    byProfile: { 'claude-main': quota('claude-main', 62, 31) },
  } as never);
  return { online, scenarioId: scenario.id, play };
}

async function open(w: World, settings: UiSettings = TEST_UI_SETTINGS): Promise<RenderedApp> {
  const app = await renderApp({ connector: w.online.connector, size: SIZE, settings });
  await app.waitForText('Pipeline');
  return app;
}

/** Tab walks chat -> edge -> panel: the tab reads keys only when the panel has the focus. */
async function focusPanel(app: RenderedApp): Promise<void> {
  app.press('\t');
  await app.settle();
  app.press('\t');
  await app.waitForText(/Side bar\s+←\s+Tabs/);
}

function settingsConfirm(confirm: 'always' | 'off'): UiSettings {
  return { ...TEST_UI_SETTINGS, overview: { ...TEST_UI_SETTINGS.overview, confirm } };
}

describe('what the Overview draws', () => {
  it('shows the pipeline, the demands with their dependencies, the Actor, the events and the quota', async () => {
    const w = world();
    const app = await open(w);
    const frame = app.frame();
    expect(frame).toContain('Need: Charge by usage');
    expect(frame).toContain('● Executing');
    expect(frame).toContain('✓ Planning');
    expect(frame).toContain('○ Integrating');
    expect(frame).toContain('Demands');
    expect(frame).toMatch(/D4 ← D2, D3\s+Demand D4/);
    expect(frame).toMatch(/D2 ← D1\s+Demand D2\s+running/);
    expect(frame).toMatch(/1\/4/);
    // The Actor of D2 started 5 minutes ago with 30 minutes to work: about 25 minutes left.
    expect(frame).toMatch(/claude\/claude-main sonnet · D2\s+2[45]m\d\ds left/);
    // The event of the scenario is listed; the flood type is hidden.
    expect(frame).toContain('demand.transitioned');
    expect(frame).not.toContain('session.update');
    expect(frame).toContain('claude-main');
    expect(frame).toContain('62%');
  });

  it('says a Claude Code account with no reading is read at its first session (N328, [proposta])', async () => {
    const w = world();
    w.online.stores.quotas.setState({
      byProfile: {
        'claude-code/main': quota('claude-code/main', undefined, undefined, 'unknown'),
        'codex/work': quota('codex/work', undefined, undefined, 'unknown'),
      },
    } as never);
    const app = await open(w);
    expect(app.frame()).toMatch(/claude-code\/main\s+read at the 1st session/);
    expect(app.frame()).toMatch(/codex\/work\s+no reading/);
  });

  it('marks a paused Actor and a paused play', async () => {
    const w = world({ paused: true });
    w.online.stores.activity.setState((s: { pausedPlays: object }) => ({
      ...s,
      pausedPlays: { [w.play.id]: NOW },
    }));
    const app = await open(w);
    const frame = app.frame();
    expect(frame).toMatch(/‖ claude\/claude-main sonnet · D2\s+paused/);
    expect(frame).toMatch(/Pipeline\s+paused/);
  });

  it('says so when the scenario has no play and no Actor', async () => {
    const w = world();
    w.online.stores.plays.setState({ byId: {} } as never);
    w.online.stores.activity.setState({ actors: {}, pausedPlays: {} } as never);
    const app = await open(w);
    const frame = app.frame();
    expect(frame).toContain('This scenario has no play yet.');
    expect(frame).toContain('No demands yet.');
    expect(frame).toContain('No Actor at work.');
  });

  it('draws the same in Portuguese', async () => {
    const w = world();
    const app = await renderApp({
      connector: w.online.connector,
      size: SIZE,
      systemLocale: 'pt_BR.UTF-8',
    });
    const frame = await app.waitForText('Demandas');
    expect(frame).toContain('Necessidade: Charge by usage');
    expect(frame).toContain('Atores');
  });
});

describe('the controls', () => {
  const REPLY = {} as never;

  it('Shift+P asks first, and y pauses the play through the same route as /pause', async () => {
    const w = world();
    const pause = vi.spyOn(w.online.client, 'pausePlay').mockResolvedValue(REPLY);
    const app = await open(w);
    await focusPanel(app);
    app.press('P');
    const asked = await app.waitForText('Pause the play “Charge by usage”?');
    expect(asked).toContain('Press y to');
    expect(pause).not.toHaveBeenCalled();
    app.press('y');
    await waitFor(() => pause.mock.calls.length > 0, 'the call of pausePlay');
    expect(pause).toHaveBeenCalledWith(w.play.id);
    await app.waitForText('Play paused.');
  });

  it('any other key withdraws the question and nothing is called', async () => {
    const w = world();
    const pause = vi.spyOn(w.online.client, 'pausePlay').mockResolvedValue(REPLY);
    const app = await open(w);
    await focusPanel(app);
    app.press('P');
    await app.waitForText('Press y to');
    app.press('n');
    await waitFor(() => !app.frame().includes('Press y to'), 'the question gone');
    expect(pause).not.toHaveBeenCalled();
  });

  it('with ui.overview.confirm: off it runs at once', async () => {
    const w = world();
    const pause = vi.spyOn(w.online.client, 'pausePlay').mockResolvedValue(REPLY);
    const app = await open(w, settingsConfirm('off'));
    await focusPanel(app);
    app.press('P');
    await waitFor(() => pause.mock.calls.length > 0, 'the call of pausePlay');
    expect(app.frame()).not.toContain('Press y to');
    await app.waitForText('Play paused.');
  });

  it('does not act while the panel has no focus', async () => {
    const w = world();
    const pause = vi.spyOn(w.online.client, 'pausePlay').mockResolvedValue(REPLY);
    const app = await open(w, settingsConfirm('off'));
    app.press('P');
    await app.settle();
    expect(pause).not.toHaveBeenCalled();
  });

  it('Shift+R resumes a paused play, and a conflict of the daemon is said in words', async () => {
    const w = world({ playPaused: true });
    const resume = vi.spyOn(w.online.client, 'resumePlay').mockRejectedValue(
      new ApiRequestError({
        status: 409,
        body: { code: 'conflict', message: 'not paused' },
      }),
    );
    const app = await open(w, settingsConfirm('off'));
    await focusPanel(app);
    app.press('R');
    await waitFor(() => resume.mock.calls.length > 0, 'the call of resumePlay');
    expect(resume).toHaveBeenCalledWith(w.play.id);
    await app.waitForText('Nothing to do');
  });

  it('does not offer "resume" for a play that is not paused (P25)', async () => {
    const w = world();
    const resume = vi.spyOn(w.online.client, 'resumePlay').mockResolvedValue(REPLY);
    const app = await open(w, settingsConfirm('off'));
    await focusPanel(app);
    app.press('R');
    await app.settle();
    expect(resume).not.toHaveBeenCalled();
  });

  it('offers "resume" for a play paused before the TUI connected (P25)', async () => {
    // The stores come from the snapshot (`ApiPlay.paused`), with no `play.paused` event.
    const w = world();
    w.online.stores.plays.setState({
      byId: { [w.play.id]: { ...w.play, paused: true } },
    } as never);
    const resume = vi.spyOn(w.online.client, 'resumePlay').mockResolvedValue(REPLY);
    const app = await open(w, settingsConfirm('off'));
    await focusPanel(app);
    app.press('R');
    await waitFor(() => resume.mock.calls.length > 0, 'the call of resumePlay');
    expect(resume).toHaveBeenCalledWith(w.play.id);
  });

  it('Shift+A pauses the Actor by its attempt, and Shift+U resumes a paused one', async () => {
    const w = world();
    const pause = vi.spyOn(w.online.client, 'pauseAttempt').mockResolvedValue(REPLY);
    const resume = vi.spyOn(w.online.client, 'resumeAttempt').mockResolvedValue(REPLY);
    const app = await open(w, settingsConfirm('off'));
    await focusPanel(app);
    app.press('U');
    await app.settle();
    // A running Actor has nothing to resume.
    expect(resume).not.toHaveBeenCalled();
    app.press('A');
    await waitFor(() => pause.mock.calls.length > 0, 'the call of pauseAttempt');
    expect(pause).toHaveBeenCalledWith('A1');
    await app.waitForText('Actor claude/claude-main paused.');
    // The `attempt.paused` event arrives and the Actor is the one that can be resumed.
    w.online.stores.activity.setState({
      actors: { A1: actor(w.play.id, { paused: 'actor' }) },
    } as never);
    await app.waitForText('paused');
    app.press('U');
    await waitFor(() => resume.mock.calls.length > 0, 'the call of resumeAttempt');
    expect(resume).toHaveBeenCalledWith('A1');
  });
});

describe('following a play without reading the REST API', () => {
  it('redraws on what the stores get, with no HTTP request', async () => {
    const w = world();
    const fetched = vi.spyOn(globalThis, 'fetch');
    const called = vi.spyOn(w.online.client, 'call');
    const app = await open(w);
    // The shell reads the finished plays of the side bar once, when it opens (P11); the redraws
    // below must not read anything else.
    called.mockClear();
    const stores: DaemonStores = w.online.stores;
    stores.plays.setState({
      byId: { [w.play.id]: { ...w.play, state: 'INTEGRATING' } },
    } as never);
    await app.waitForText('● Integrating');
    stores.demands.setState(
      (s) =>
        ({
          byPlay: {
            ...s.byPlay,
            [w.play.id]: {
              demands: [
                demand(w.play.id, 'D1', 'approved'),
                demand(w.play.id, 'D2', 'approved', ['D1']),
                demand(w.play.id, 'D3', 'approved', ['D1']),
                demand(w.play.id, 'D4', 'approved', ['D2', 'D3']),
              ],
              stages: [],
            },
          },
        }) as never,
    );
    await app.waitForText('4/4');
    stores.activity.setState({ actors: {}, pausedPlays: {} } as never);
    await app.waitForText('No Actor at work.');
    stores.events.setState((s) => ({
      events: [...s.events, event(3, 'play.transitioned', w.play.id, w.scenarioId)],
    }));
    await app.waitForText('play.transitioned');
    expect(fetched).not.toHaveBeenCalled();
    expect(called).not.toHaveBeenCalled();
  });
});
