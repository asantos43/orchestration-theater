// SPDX-License-Identifier: MPL-2.0
import { reduceTrajectories, settleDiff } from '@otheater/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../../ink.test-support.js';
import { saveActiveTab } from '../../layout/use-layout.js';
import { fakeOnline, play, scenario, type FakeOnline } from '../../layout.test-support.js';
import { DEFAULT_UI_SETTINGS, type TrajectoryOpenMode, type UiSettings } from '../../settings.js';
import { DEMAND_DIFF, fakePlayEvents, trajectoryEvent } from './trajectory.test-support.js';

/**
 * The Trajectories tab over the stores of the client: the history of a play of the fake-agent
 * (its events are in the store, as the REST read leaves them), the steps that open and close,
 * the diff of the demand, and the events of the stream that arrive later.
 */

afterEach(cleanupApps);

const settings = (open: TrajectoryOpenMode, diffLines = 200): UiSettings => ({
  ...DEFAULT_UI_SETTINGS,
  trajectories: { open, keep: 5000, diffLines },
});

interface Opened {
  readonly app: RenderedApp;
  readonly online: FakeOnline;
}

async function open(options: {
  readonly mode?: TrajectoryOpenMode;
  readonly diffLines?: number;
  readonly withDiff?: boolean;
  readonly diff?: string;
  /** Takes the place of the read of the diff: the stores of the test reach no daemon. */
  readonly loadDemandDiff?: FakeOnline['stores']['loadDemandDiff'];
  readonly events?: ReturnType<typeof fakePlayEvents>;
}): Promise<Opened> {
  const online = fakeOnline();
  const { stores } = online;
  stores.loadDemandDiff = options.loadDemandDiff ?? (() => Promise.resolve());
  const only = scenario('Billing API');
  stores.scenarios.setState({ byId: { [only.id]: only } } as never);
  const running = play(only.id, { id: 'P1' });
  stores.plays.setState({ byId: { P1: running } } as never);
  stores.trajectories.setState({
    plays: {
      P1: {
        load: 'loaded',
        events: options.events ?? fakePlayEvents(),
        dropped: 0,
        error: undefined,
      },
    },
    diffs:
      options.withDiff === false
        ? {}
        : {
            'P1/D1': {
              load: 'loaded',
              value: { ...DEMAND_DIFF, diff: options.diff ?? DEMAND_DIFF.diff },
              error: undefined,
            },
          },
  });
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: 60 },
    settings: settings(options.mode ?? 'last', options.diffLines),
  });
  await app.waitForText('Billing API');
  const layout = online.layouts[0];
  if (layout === undefined) throw new Error('the layout was not opened');
  layout.update({ openTabs: ['overview', 'trajectories'] });
  saveActiveTab(layout, 'trajectories');
  await app.waitForText('Play P1');
  return { app, online };
}

async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

/** Tab, Tab: the focus goes from the chat to the border and then to the panel. */
async function focusPanel(app: RenderedApp): Promise<void> {
  await key(app, '\t');
  await key(app, '\t');
}

describe('the Trajectories tab', () => {
  it('shows every turn of the play of the fake-agent, with the last one open and the diff of the demand', async () => {
    const { app } = await open({});
    const frame = await app.settle();
    expect(frame).toContain('Attempt 1 · demand D1');
    expect(frame).toContain('Turn 1');
    expect(frame).toContain('Turn 2');
    // The first turn starts folded; the last one is open.
    expect(frame).not.toContain('Writing the file');
    expect(frame).toContain('All done');
    expect(frame).toContain('Diff · demand D1');
    expect(frame).toContain('+written by the fake Actor');
    expect(frame).toContain('Demand moves');
  });

  it('opens and closes each step with Enter, one at a time with the arrows, and keeps it in the layout', async () => {
    const { app, online } = await open({});
    await focusPanel(app);
    // The cursor is on the attempt: Enter folds it, with its turns and its diff.
    let frame = await key(app, '\r');
    expect(frame).not.toContain('Turn 1');
    expect(frame).not.toContain('+written by the fake Actor');
    expect(frame).toContain('▸ Attempt 1');
    frame = await key(app, '\r');
    expect(frame).toContain('Turn 1');
    // Down to Turn 1 and open it: its entries show, with the tool call and the permission.
    await key(app, '\x1b[B');
    frame = await key(app, '\r');
    expect(frame).toContain('Writing the file');
    expect(frame).toContain('Write notes.txt [edit] completed');
    expect(frame).toContain('run_command -> allow');
    expect(online.layouts[0]?.layout.collapsedSections).toContain('trajectories.a1.t1');
    // Closing the last turn (Down, Enter) hides what it said.
    await key(app, '\x1b[B');
    frame = await key(app, '\r');
    expect(frame).not.toContain('All done');
    expect(frame).toContain('▸ Turn 2');
  });

  it('clips a long diff at ui.trajectories.diff_lines and says how many lines were left out', async () => {
    const long = Array.from({ length: 40 }, (_, index) => `+line ${String(index)}`).join('\n');
    const { app } = await open({ diffLines: 10, diff: long });
    const frame = await app.settle();
    expect(frame).toContain('+line 9');
    expect(frame).not.toContain('+line 10');
    expect(frame).toContain('... 30 more lines');
  });

  it('open: none shows only the attempt, open: all shows every step', async () => {
    const none = await open({ mode: 'none' });
    let frame = await none.app.settle();
    expect(frame).toContain('▸ Attempt 1');
    expect(frame).not.toContain('Turn 1');
    cleanupApps();
    const all = await open({ mode: 'all' });
    frame = await all.app.settle();
    expect(frame).toContain('Writing the file');
    expect(frame).toContain('All done');
    expect(frame).toContain('+written by the fake Actor');
  });

  it('asks the daemon for the diff of an open demand once, and shows it when it arrives', async () => {
    const ask = vi.fn(() => Promise.resolve());
    const { app, online } = await open({ withDiff: false, loadDemandDiff: ask });
    expect(ask).toHaveBeenCalledWith('P1', 'D1');
    expect(await app.settle()).toContain('Reading the diff...');
    online.stores.trajectories.setState((state) => settleDiff(state, DEMAND_DIFF));
    const frame = await app.waitForText('+written by the fake Actor');
    expect(frame).toContain('Diff · demand D1');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('follows the events of the stream: a new message of the Actor appears and a new turn is a new step', async () => {
    const { app, online } = await open({ mode: 'all' });
    const live = [
      trajectoryEvent(20, 'session.update', {
        update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'One more thing' } },
      }),
    ];
    online.stores.trajectories.setState((state) =>
      live.reduce((next, event) => reduceTrajectories(next, event as never, 5000), state),
    );
    const frame = await app.waitForText('One more thing');
    expect(frame).toContain('Turn 3');
    expect(frame).toContain('running');
  });

  it('says so when the scenario has no play, and while the history is being read', async () => {
    const online = fakeOnline();
    const only = scenario('Docs site');
    online.stores.scenarios.setState({ byId: { [only.id]: only } } as never);
    const app = await renderApp({
      connector: online.connector,
      size: { columns: 140, rows: 40 },
    });
    await app.waitForText('Docs site');
    online.layouts[0]?.update({ openTabs: ['overview', 'trajectories'] });
    if (online.layouts[0] !== undefined) saveActiveTab(online.layouts[0], 'trajectories');
    await app.waitForText('This scenario has no play yet.');
    const running = play(only.id, { id: 'P9' });
    online.stores.loadTrajectory = vi.fn(() => Promise.resolve());
    online.stores.plays.setState({ byId: { P9: running } } as never);
    await app.waitForText('Play P9');
  });
});
