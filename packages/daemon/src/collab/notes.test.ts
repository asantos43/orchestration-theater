// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { notesKey, SCRIPT_KEY, type NewEvent } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonRegistries } from '../registries.js';
import { ToolFailure, ToolHandlers, type ToolCall } from '../mcp/handlers.js';
import {
  DEFAULT_COLLAB_NOTES,
  NOTE_TOOL_NAMES,
  NOTES_NOTICE,
  noteToolHandlers,
  registerNoteTools,
  type CollabNotesSettings,
} from './notes.js';

const registries = buildDaemonRegistries();

function demand(id: string, dependsOn: string[] = []) {
  return {
    id,
    title: id,
    description: id,
    dependsOn,
    contract: { inputs: [], outputs: [] },
    expectedFiles: [`${id}.txt`],
    complexity: 'low' as const,
    acceptanceCriteria: [],
    verify: [],
    verifyWaiver: 'a test',
  };
}

/** `a` and `b` are independent; `c` depends on `a`; `d` depends on `c`. */
async function newStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore({ clock: new FakeClock(1_000) });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
  for (const id of ['p1', 'p2']) {
    await store.plays.create({
      id,
      scenarioId: 's1',
      need: 'need',
      flowId: 'play.default',
      flowVersion: 1,
      state: 'EXECUTING',
      counters: {},
    });
  }
  await store.blackboard.put({
    playId: 'p1',
    key: SCRIPT_KEY,
    value: {
      contracts: [],
      demands: [demand('a'), demand('b'), demand('c', ['a']), demand('d', ['c'])],
    },
  });
  return store;
}

interface Harness {
  readonly events: NewEvent[];
  run(name: string, input: unknown, demandId?: string | null, playId?: string): Promise<unknown>;
}

function harness(store: InMemoryStore, settings: Partial<CollabNotesSettings> = {}): Harness {
  const events: NewEvent[] = [];
  const handlers = noteToolHandlers({
    store,
    settings: () => ({ ...DEFAULT_COLLAB_NOTES, ...settings }),
  });
  return {
    events,
    run: async (name, input, demandId = 'a', playId = 'p1') => {
      const tool = registries.tools.get(name);
      const handler = handlers[name];
      if (tool === undefined || handler === undefined) throw new Error(`no tool ${name}`);
      const attemptId = `${playId}/${demandId ?? 'none'}/1`;
      const call: ToolCall = {
        tool,
        input,
        caller: {
          role: 'actor',
          attemptId,
          sessionId: undefined,
          correlation: demandId === null ? { playId, attemptId } : { playId, demandId, attemptId },
          record: (event) => {
            events.push(event);
            return Promise.resolve();
          },
        },
      };
      return await handler(call);
    },
  };
}

function failure(value: unknown): ToolFailure {
  expect(value).toBeInstanceOf(ToolFailure);
  return value as ToolFailure;
}

interface NotesReply {
  readonly source: string;
  readonly notice: string;
  readonly notes: readonly { demand: string; version: number; text: string; author: string }[];
}

describe('post_note', () => {
  it('writes one version of notes/<demand> with the attempt as author and records note.posted', async () => {
    const store = await newStore();
    const h = harness(store);
    expect(await h.run('post_note', { text: 'the file is utf-8' })).toEqual({
      key: notesKey('a'),
      version: 1,
      remaining: 19,
    });
    expect(await h.run('post_note', { text: 'and ends with a newline' })).toMatchObject({
      version: 2,
      remaining: 18,
    });
    const history = await store.blackboard.history('p1', notesKey('a'));
    expect(history.map((entry) => entry.author)).toEqual(['p1/a/1', 'p1/a/1']);
    expect(history[0]?.value).toEqual({
      text: 'the file is utf-8',
      demandId: 'a',
      attemptId: 'p1/a/1',
    });
    expect(h.events.map((event) => event.type)).toEqual(['note.posted', 'note.posted']);
    // The text stays in the blackboard; the event has its length only.
    expect(h.events[0]?.payload).toEqual({
      demandId: 'a',
      key: notesKey('a'),
      version: 1,
      chars: 17,
    });
  });

  it('refuses a note longer than max_chars, with collab.limit_reached', async () => {
    const store = await newStore();
    const h = harness(store, { max_chars: 5 });
    const refused = failure(await h.run('post_note', { text: 'too long' }));
    expect(refused.code).toBe('limit_reached');
    expect(refused.details).toEqual({ limit: 'max_chars', max: 5 });
    expect(await store.blackboard.history('p1', notesKey('a'))).toEqual([]);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'collab.limit_reached',
        payload: { feature: 'notes', limit: 'max_chars', demandId: 'a', value: 8, max: 5 },
      }),
    ]);
    expect(await h.run('post_note', { text: 'short' })).toMatchObject({ version: 1 });
  });

  it('refuses a note past max_per_actor, counted per demand', async () => {
    const store = await newStore();
    const h = harness(store, { max_per_actor: 2 });
    await h.run('post_note', { text: 'one' });
    expect(await h.run('post_note', { text: 'two' })).toMatchObject({ remaining: 0 });
    const refused = failure(await h.run('post_note', { text: 'three' }));
    expect(refused.code).toBe('limit_reached');
    expect(refused.details).toEqual({ limit: 'max_per_actor', max: 2 });
    expect(h.events.at(-1)).toMatchObject({
      type: 'collab.limit_reached',
      payload: { limit: 'max_per_actor', demandId: 'a', value: 3, max: 2 },
    });
    // Another demand has its own count.
    expect(await h.run('post_note', { text: 'b too' }, 'b')).toMatchObject({ version: 1 });
  });

  it('is refused under mode off and outside a demand', async () => {
    const store = await newStore();
    expect(
      failure(await harness(store, { mode: 'off' }).run('post_note', { text: 'x' })).code,
    ).toBe('collab_off');
    expect(failure(await harness(store).run('post_note', { text: 'x' }, null)).code).toBe(
      'no_demand',
    );
  });

  it('does not undo the note when the event cannot be recorded', async () => {
    const store = await newStore();
    const tool = registries.tools.get('post_note');
    const handler = noteToolHandlers({ store, settings: () => DEFAULT_COLLAB_NOTES }).post_note;
    if (tool === undefined || handler === undefined) throw new Error('no post_note');
    const reply = await handler({
      tool,
      input: { text: 'kept' },
      caller: {
        role: 'actor',
        attemptId: 'p1/a/1',
        sessionId: undefined,
        correlation: { playId: 'p1', demandId: 'a', attemptId: 'p1/a/1' },
        record: () => Promise.reject(new Error('log is down')),
      },
    });
    expect(reply).toMatchObject({ version: 1 });
  });
});

describe('read_notes', () => {
  async function seeded(): Promise<InMemoryStore> {
    const store = await newStore();
    const h = harness(store);
    await h.run('post_note', { text: 'from a' }, 'a');
    await h.run('post_note', { text: 'from b' }, 'b');
    await h.run('post_note', { text: 'from c' }, 'c');
    await h.run('post_note', { text: 'from d' }, 'd');
    await h.run('post_note', { text: 'a again' }, 'a');
    await harness(store).run('post_note', { text: 'other play' }, 'a', 'p2');
    return store;
  }

  it('mode play: the notes of every other demand of the play, marked as data', async () => {
    const store = await seeded();
    const reply = (await harness(store).run('read_notes', {}, 'c')) as NotesReply;
    expect(reply.source).toBe('notes_from_other_actors');
    expect(reply.notice).toBe(NOTES_NOTICE);
    expect(reply.notes.map((note) => `${note.demand}:${note.text}`)).toEqual([
      'a:from a',
      'a:a again',
      'b:from b',
      'd:from d',
    ]);
    expect(reply.notes[0]).toMatchObject({ version: 1, author: 'p1/a/1' });
  });

  it('mode deps: only the dependencies and the dependents of the caller', async () => {
    const store = await seeded();
    const h = harness(store, { mode: 'deps' });
    const ofC = (await h.run('read_notes', {}, 'c')) as NotesReply;
    expect(ofC.notes.map((note) => note.text)).toEqual(['from a', 'a again', 'from d']);
    const ofB = (await h.run('read_notes', {}, 'b')) as NotesReply;
    expect(ofB.notes).toEqual([]);
    expect(failure(await h.run('read_notes', { demand: 'b' }, 'c')).code).toBe('not_visible');
  });

  it('mode deps without a script sees nothing', async () => {
    const store = await seeded();
    const reply = (await harness(store, { mode: 'deps' }).run(
      'read_notes',
      {},
      'a',
      'p2',
    )) as NotesReply;
    expect(reply.notes).toEqual([]);
  });

  it('filters by demand, and never shows the caller its own notes', async () => {
    const store = await seeded();
    const h = harness(store);
    const onlyD = (await h.run('read_notes', { demand: 'd' }, 'c')) as NotesReply;
    expect(onlyD.notes.map((note) => note.text)).toEqual(['from d']);
    const own = failure(await h.run('read_notes', { demand: 'c' }, 'c'));
    expect(own.code).toBe('not_visible');
    expect(own.message).toContain('not your own');
  });

  it('is refused under mode off', async () => {
    const store = await seeded();
    expect(failure(await harness(store, { mode: 'off' }).run('read_notes', {}, 'c')).code).toBe(
      'collab_off',
    );
  });
});

describe('registerNoteTools', () => {
  it('registers both tools and keeps a handler already there', () => {
    const own = (): string => 'own';
    const handlers = new ToolHandlers().register('read_notes', own);
    registerNoteTools(handlers, {
      store: new InMemoryStore({ clock: new FakeClock(0) }),
      settings: () => DEFAULT_COLLAB_NOTES,
    });
    for (const name of NOTE_TOOL_NAMES) expect(handlers.has(name)).toBe(true);
    expect(handlers.get('read_notes')).toBe(own);
  });

  it('the tools are of the Actor only', () => {
    for (const name of NOTE_TOOL_NAMES) {
      expect(registries.tools.get(name)?.roles).toEqual(['actor']);
    }
  });
});
