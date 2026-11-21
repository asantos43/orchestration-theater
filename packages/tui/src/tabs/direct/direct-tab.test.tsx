// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../../layout.test-support.js';
import type { TabContentMap } from '../../layout/tab-content.js';
import { createDirectTab } from './direct-tab.js';
import {
  FakeDirectApi,
  openDirectTab,
  requestError,
  said,
  session,
} from './direct.test-support.js';

/**
 * The tab Direct session over a fake API of sessions (P19 of Phase 7): what it draws, what each key
 * asks of the daemon and how it shows a refusal. The same screen against the real daemon with the
 * fake agent is in `direct.e2e.test.tsx`.
 */

afterEach(cleanupApps);

const ESC = '\x1b';
const ENTER = '\r';
const RIGHT = '\x1b[C';

async function open(
  api: FakeDirectApi,
  options: { readonly systemLocale?: string } = {},
): Promise<{ app: RenderedApp; online: FakeOnline }> {
  const online = fakeOnline();
  seedStores(online.stores);
  const tabContent: TabContentMap = { direct: createDirectTab({ api }) };
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 230, rows: 60 },
    tabContent,
    ...options,
  });
  await app.waitForText(options.systemLocale === undefined ? 'SCENARIOS' : 'CENÁRIOS');
  await openDirectTab(
    app,
    options.systemLocale === undefined
      ? undefined
      : { palette: 'Paleta de comandos', tab: 'Sessão direta' },
  );
  return { app, online };
}

async function key(app: RenderedApp, keys: string): Promise<string> {
  app.press(keys);
  return app.settle();
}

/** The daemon says something about a direct session: the tab reads it again. */
let eventId = 0;
function emit(online: FakeOnline, type = 'direct.session.message'): void {
  eventId += 1;
  const events = online.stores.events.getState().events;
  online.stores.events.setState({
    events: [...events, { id: 90_000 + eventId, type, payload: {}, timestamp: 1 }],
  } as never);
}

/** Waits (Esc is read after a short wait for an escape sequence) until the text is off the screen. */
async function gone(app: RenderedApp, text: string): Promise<void> {
  await waitFor(() => !app.frame().includes(text), `"${text}" to leave the screen`);
}

async function type(app: RenderedApp, text: string): Promise<void> {
  for (const char of text) await key(app, char);
}

describe('the tab Direct session', () => {
  it('shows an empty state with the key that opens the first session', async () => {
    const { app } = await open(new FakeDirectApi());
    const frame = await app.waitForText('No direct session yet. Press N to open one.');
    expect(frame).toContain('N new');
  });

  it('opens a session with the Executor chosen from the profile list', async () => {
    const api = new FakeDirectApi();
    const { app } = await open(api);
    await key(app, 'n');
    const form = await app.waitForText('Open a direct session');
    expect(form).toContain('the first that can take it');
    expect(form).toContain('as configured');
    // Right: from "the first that can take it" to the first Executor, then to the second.
    await key(app, RIGHT);
    await key(app, RIGHT);
    expect(app.frame()).toContain('‹ e2 ›');
    await key(app, ENTER);
    const frame = await app.waitForText('Session d1 open.');
    expect(api.openBodies).toEqual([{ executor: 'e2' }]);
    expect(frame).toContain('d1 · fake/one · own worktree · idle');
    expect(frame).toContain('branch direct/d1');
  });

  it('asks to confirm a session that writes in the folder of the scenario', async () => {
    const api = new FakeDirectApi();
    api.askConfirm = true;
    const { app } = await open(api);
    await key(app, 'n');
    await app.waitForText('Open a direct session');
    // Second field: the folder; Right until "scenario folder" (configured, worktree, read only, scenario).
    await key(app, '\t');
    await key(app, RIGHT);
    await key(app, RIGHT);
    await key(app, RIGHT);
    expect(app.frame()).toContain('‹ scenario folder ›');
    await key(app, ENTER);
    await app.waitForText('writes in the folder of the scenario itself');
    expect(api.sessions.size).toBe(0);
    // Esc: nothing opens.
    await key(app, ESC);
    await gone(app, 'writes in the folder of the scenario itself');
    expect(api.sessions.size).toBe(0);
    // Again, and confirm with Enter.
    await key(app, 'n');
    await app.waitForText('Open a direct session');
    await key(app, '\t');
    await key(app, RIGHT);
    await key(app, RIGHT);
    await key(app, RIGHT);
    await key(app, ENTER);
    await app.waitForText('writes in the folder of the scenario itself');
    await key(app, ENTER);
    await app.waitForText('Session d1 open.');
    expect(api.openBodies.map((body) => body.confirm)).toEqual([undefined, undefined, true]);
    expect(api.sessions.get('d1')?.workspace).toBe('scenario');
  });

  it('shows the refusal of a profile with no quota or no money, and opens nothing', async () => {
    const api = new FakeDirectApi();
    api.openError = requestError('quota_exhausted', 429, 'fake/one: no quota until 14:00');
    const { app } = await open(api);
    await key(app, 'n');
    await app.waitForText('Open a direct session');
    await key(app, ENTER);
    const frame = await app.waitForText('No quota or money left for this profile now');
    expect(frame).toContain('no quota until 14:00');
    expect(api.sessions.size).toBe(0);
  });

  it('writes to the Actor, runs a command of the client with "/" and leaves with Esc', async () => {
    const api = new FakeDirectApi();
    api.sessions.set(
      'd1',
      session(
        'd1',
        {
          commands: [
            { id: 'fake:fake-command', name: '/fake:fake-command', description: '', args: '' },
          ],
        },
        [said('producer', 'hello'), said('actor', 'hi, I am the actor')],
      ),
    );
    const { app } = await open(api);
    const frame = await app.waitForText('hi, I am the actor');
    expect(frame).toContain('you › hello');
    expect(frame).toContain('actor › hi, I am the actor');
    expect(frame).toContain('Client commands: /fake:fake-command');
    await key(app, 't');
    await type(app, 'do it');
    await key(app, ENTER);
    await type(app, '/fake:fake-command now');
    await key(app, ENTER);
    expect(api.calls).toEqual(['send d1 do it', 'command d1 /fake:fake-command now']);
    // The keyboard is the box's: a bare letter is text, not an action of the tab.
    await type(app, 'x');
    expect(api.calls).toHaveLength(2);
    await key(app, ESC);
    // Back to the screen: the letter is an action again (X closes the session).
    await key(app, 'x');
    await app.waitForText('Session closed. The work stayed in the branch direct/d1.');
    expect(api.calls.at(-1)).toBe('close d1');
  });

  it('shows what the policy decided: a write barred in a read-only session', async () => {
    const api = new FakeDirectApi();
    api.sessions.set(
      'd1',
      session('d1', { workspace: 'readonly', branch: null, state: 'idle', turns: 1 }, [
        said('producer', 'write a file'),
        {
          kind: 'tool',
          turn: 1,
          at: 1,
          toolCallId: 't1',
          title: 'Write notes.txt',
          status: 'failed',
        },
        {
          kind: 'decision',
          turn: 1,
          at: 1,
          title: 'Write notes.txt',
          answered: 'reject',
          rule: 'direct.readonly',
          reason: 'the session is read only',
        },
        said('actor', 'I could not write it'),
      ]),
    );
    const { app } = await open(api);
    const frame = await app.waitForText('I could not write it');
    expect(frame).toContain('read only');
    expect(frame).toContain('barred: Write notes.txt (direct.readonly: the session is read only)');
  });

  it('promotes the result to a demand and to a piece, and stops a running turn', async () => {
    const api = new FakeDirectApi();
    api.sessions.set(
      'd1',
      session('d1', {}, [said('producer', 'plan it'), said('actor', 'the plan')]),
    );
    const { app, online } = await open(api);
    await app.waitForText('the plan');
    await key(app, 'd');
    await app.waitForText('Result sent to the demand queue (I1).');
    await key(app, 'p');
    await app.waitForText('Piece opened from the result (PL1).');
    expect(api.calls).toEqual(['promote d1 demand', 'promote d1 piece']);
    // A turn that does not run has nothing to stop.
    await key(app, 'c');
    await app.waitForText('No turn is running in this session.');
    api.sessions.set('d1', session('d1', { state: 'running' }, [said('producer', 'go')]));
    emit(online);
    await app.waitForText('d1 · fake/one · own worktree · running');
    await key(app, 'c');
    await app.waitForText('Turn stopped.');
    expect(api.calls.at(-1)).toBe('cancel d1');
  });

  it('has nothing to promote before the Actor has answered', async () => {
    const api = new FakeDirectApi();
    api.sessions.set('d1', session('d1', {}, [said('producer', 'hello')]));
    const { app } = await open(api);
    await app.waitForText('you › hello');
    await key(app, 'd');
    await app.waitForText('there is nothing to send on');
    expect(api.calls).toEqual([]);
  });

  it('speaks Portuguese when the locale is pt-BR', async () => {
    const api = new FakeDirectApi();
    const { app } = await open(api, { systemLocale: 'pt_BR.UTF-8' });
    await app.waitForText('Nenhuma sessão direta ainda. Aperte N para abrir uma.');
    await key(app, 'n');
    const form = await app.waitForText('Abrir uma sessão direta');
    expect(form).toContain('o primeiro que puder assumir');
  });
});
