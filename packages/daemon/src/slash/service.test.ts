// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput, PermissionDenied } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetService } from '../budget/index.js';
import { parseConfig, type DaemonConfig } from '../config.js';
import type { DirectiveService } from '../directives/index.js';
import { createSilentLogger } from '../logger.js';
import type { ProducerChannel } from '../orchestration/channel.js';
import type { DirectorSessions } from '../orchestration/director.js';
import type { PlayRunner } from '../pipeline/runner.js';
import type { ProfileService } from '../profiles/service.js';
import type { QuotaService } from '../quota/index.js';
import type { UsageService } from '../usage/index.js';
import { SlashCatalog, SlashCommandService, parseSlashLine } from './index.js';
import { bareCommandName, clientPrefixOf } from './parse.js';

/**
 * The registry of the `/` commands (Phase 7, P3): what it lists by type and state of the scenario,
 * what it refuses and why, the confirmation, `chat.slash_access`, the templates and the commands of
 * the client of the Director. The services are stubs that count what reaches them: the e2e test of
 * the daemon runs the same registry against the fake agent.
 */

let catalog: SlashCatalog;
beforeAll(async () => {
  catalog = await SlashCatalog.load();
});

const pausedSnapshot = { context: { paused: { mode: 'drain', at: 1 } } };

interface Rig {
  readonly service: SlashCommandService;
  readonly store: InMemoryStore;
  readonly sent: { playId: string; event: Record<string, unknown> }[];
  readonly messages: string[];
  readonly attached: string[];
  readonly opened: string[];
  readonly openedInputs: { type?: string; name?: string; repo?: string }[];
  readonly setDirector: (state: ReturnType<typeof director>) => void;
  readonly interrupted: string[];
  readonly setInterruptible: (value: boolean) => void;
  /** What reached `switchDirector` (P14). */
  readonly switches: unknown[];
}

function director(options: {
  readonly inTurn?: boolean;
  readonly started?: boolean;
  readonly client?: string;
  readonly commands?: readonly { name: string; description: string; inputHint?: string }[];
}) {
  return {
    client: options.client ?? 'claude-code',
    commands: options.commands ?? [
      { name: 'compact', description: 'Compact the conversation', inputHint: '<instructions>' },
      { name: '/review', description: 'Review the code' },
    ],
    inTurn: options.inTurn ?? false,
    started: options.started ?? true,
  };
}

/** The view of the Director the stub answers (P14): two Executors, the first one is the default. */
function directorView(override: { executor: string } | null) {
  const executor = (index: number, id: string, current: boolean) => ({
    index,
    id,
    client: 'fake',
    profile: index === 1 ? 'one' : 'two',
    model: 'fake-model',
    effort: null,
    validity: 'valid',
    invalidReason: null,
    quota: 'ok',
    quotaResetsAt: null,
    current,
    isDefault: index === 1,
  });
  const running = override?.executor ?? 'fake-model@fake/one';
  return {
    scenarioId: 'project-1',
    session: 'open',
    inTurn: false,
    pending: false,
    current: {
      executor: running,
      client: 'fake',
      profile: running.endsWith('two') ? 'two' : 'one',
      model: 'fake-model',
      effort: null,
    },
    override,
    default: 'fake-model@fake/one',
    executors: [
      executor(1, 'fake-model@fake/one', running.endsWith('one')),
      executor(2, 'fake-model@fake/two', running.endsWith('two')),
    ],
    models: [{ id: 'fake-model', name: null, efforts: ['low', 'high'] }],
    efforts: ['low', 'high'],
    inTurnMode: 'wait',
  };
}

async function rig(yaml = '', locale: 'en' | 'pt-BR' = 'en'): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  for (const [id, kind] of [
    ['project-1', 'project'],
    ['chat-1', 'chat'],
    ['archived-1', 'project'],
  ] as const) {
    await store.scenarios.create({
      id,
      kind,
      flowId: 'software',
      name: `Scenario ${id}`,
      folder: '/tmp/never',
      profile: 'software',
      conventions: {},
      configOverride: {},
    });
  }
  await store.scenarios.update('archived-1', { state: 'archived' });
  const sent: Rig['sent'] = [];
  const messages: string[] = [];
  const attached: string[] = [];
  const opened: string[] = [];
  const openedInputs: { type?: string; name?: string; repo?: string }[] = [];
  let current: ReturnType<typeof director> | undefined;
  const interrupted: string[] = [];
  const switches: unknown[] = [];
  let interruptible = true;
  const config: DaemonConfig = parseConfig(yaml);
  const service = new SlashCommandService({
    store,
    clock,
    logger: createSilentLogger(),
    config,
    quota: {
      statusOf: (id: string) =>
        Promise.resolve({ profile: id, state: 'ok', cause: null, untilReset: null }),
    } as unknown as QuotaService,
    usage: {
      totals: () =>
        Promise.resolve({
          turns: 3,
          inputTokens: 100,
          outputTokens: 50,
          realUsd: 1.5,
          apiEquivalentUsd: 2,
          unknownCostTurns: 0,
          complete: true,
        }),
    } as unknown as UsageService,
    budget: { exceededOf: () => undefined } as unknown as BudgetService,
    profiles: {} as ProfileService,
    directives: { list: () => Promise.resolve([]) } as unknown as DirectiveService,
    catalog,
    locale,
    channel: {
      send: (_scenarioId: string, text: string) => {
        messages.push(text);
        return Promise.resolve();
      },
      attach: (_scenarioId: string, input: { path: string }) => {
        attached.push(input.path);
        return Promise.resolve({ id: 'att-1', name: 'notes.md' });
      },
      openChat: (input: { type?: string; name?: string; repo?: string }) => {
        if (input.repo === '/not-a-repo') {
          return Promise.reject(new InvalidInput('"/not-a-repo" is not a git repository'));
        }
        opened.push(input.name ?? input.repo ?? '');
        openedInputs.push(input);
        return Promise.resolve({
          scenarioId: input.type === 'project' ? 'project-new' : 'chat-new',
          cursor: 0,
          lastEventId: 0,
        });
      },
    } as unknown as ProducerChannel,
    runner: {
      send: async (playId: string, event: Record<string, unknown>) => {
        sent.push({ playId, event });
        const play = await store.plays.get(playId);
        if (play === undefined) throw new Error(`no play ${playId}`);
        return play;
      },
    } as unknown as PlayRunner,
    directors: {
      isAsleep: () => false,
      clientCommands: () => Promise.resolve(current),
      interrupt: (scenarioId: string) => {
        interrupted.push(scenarioId);
        return Promise.resolve(interruptible);
      },
      view: () => Promise.resolve(directorView(null)),
      switchDirector: (scenarioId: string, change: { kind: string; executor?: string }) => {
        switches.push({ scenarioId, change });
        const override = change.kind === 'default' ? null : { executor: 'fake-model@fake/two' };
        return Promise.resolve({
          status: 'applied',
          form: change.kind === 'default' ? 'new_session' : 'live',
          override,
          view: directorView(override),
        });
      },
    } as unknown as DirectorSessions,
    pauseMode: () => 'drain',
  });
  return {
    service,
    store,
    sent,
    messages,
    attached,
    opened,
    openedInputs,
    setDirector: (state) => {
      current = state;
    },
    interrupted,
    setInterruptible: (value) => {
      interruptible = value;
    },
    switches,
  };
}

async function addPlay(store: InMemoryStore, id: string, paused = false): Promise<void> {
  await store.plays.create({
    id,
    scenarioId: 'project-1',
    need: 'Do it',
    flowId: 'software',
    flowVersion: 1,
    state: 'EXECUTING',
    ...(paused ? { snapshot: pausedSnapshot } : {}),
  });
}

const idsOf = (commands: readonly { id: string }[]): string[] =>
  commands.map((command) => command.id);

describe('parsing a line', () => {
  it('splits the name from the rest and rejects what is not a command', () => {
    expect(parseSlashLine('/status')).toEqual({ name: 'status', text: '' });
    expect(parseSlashLine('  /logs   30  ')).toEqual({ name: 'logs', text: '30' });
    expect(parseSlashLine('/claude:compact keep the tests\nplease')).toEqual({
      name: 'claude:compact',
      text: 'keep the tests\nplease',
    });
    for (const line of ['status', '/ status', '//', '/1', '']) {
      expect(parseSlashLine(line), line).toBeUndefined();
    }
  });

  it('names the commands of a client with its prefix', () => {
    expect(clientPrefixOf('claude-code')).toBe('claude');
    expect(clientPrefixOf('codex')).toBe('codex');
    expect(bareCommandName('/compact')).toBe('compact');
  });
});

describe('the list valid for a scenario', () => {
  it('without a scenario holds only the commands that need none', async () => {
    const { service } = await rig();
    const ids = idsOf(await service.list());
    expect(ids).toEqual(
      expect.arrayContaining([
        'help',
        'quota',
        'cost',
        'executors',
        'profile',
        'config',
        'new',
        'doctor',
      ]),
    );
    for (const absent of ['status', 'plays', 'pause', 'cancel', 'attach', 'plan']) {
      expect(ids, absent).not.toContain(absent);
    }
  });

  it('follows the type and the state of the scenario and what its plays are doing', async () => {
    const { service, store } = await rig();
    const project = idsOf(await service.list({ scenarioId: 'project-1' }));
    expect(project).toEqual(
      expect.arrayContaining([
        'status',
        'plays',
        'logs',
        'attach',
        'export',
        'model',
        'plan',
        'review',
      ]),
    );
    // no open play: nothing to pause, resume or cancel
    for (const absent of ['pause', 'resume', 'cancel'])
      expect(project, absent).not.toContain(absent);

    await addPlay(store, 'play-1');
    const running = idsOf(await service.list({ scenarioId: 'project-1' }));
    expect(running).toEqual(expect.arrayContaining(['pause', 'cancel']));
    expect(running).not.toContain('resume');

    await store.plays.update('play-1', { snapshot: pausedSnapshot });
    const paused = idsOf(await service.list({ scenarioId: 'project-1' }));
    expect(paused).toEqual(expect.arrayContaining(['resume', 'cancel']));
    expect(paused).not.toContain('pause');

    // a chat has no plays; an archived scenario takes nothing new
    const chat = idsOf(await service.list({ scenarioId: 'chat-1' }));
    expect(chat).toContain('status');
    for (const absent of ['plays', 'pause', 'resume', 'cancel'])
      expect(chat, absent).not.toContain(absent);
    const archived = idsOf(await service.list({ scenarioId: 'archived-1' }));
    expect(archived).toContain('status');
    for (const absent of ['attach', 'plan', 'explain'])
      expect(archived, absent).not.toContain(absent);
  });

  it('describes each command in the language asked for, with the key of the catalog', async () => {
    const { service, store } = await rig();
    await addPlay(store, 'play-1');
    const english = (await service.list({ scenarioId: 'project-1', lang: 'en' })).find(
      (command) => command.id === 'cancel',
    );
    const portuguese = (await service.list({ scenarioId: 'project-1', lang: 'pt-BR' })).find(
      (command) => command.id === 'cancel',
    );
    expect(english).toMatchObject({
      name: '/cancel',
      origin: 'daemon',
      group: 'control',
      descriptionKey: 'desc.cancel',
      confirm: true,
    });
    expect(english?.description).not.toBe('');
    expect(portuguese?.description).not.toBe(english?.description);
  });

  it('answers in ui.locale when the caller names no language', async () => {
    const { service } = await rig('', 'pt-BR');
    const pt = (await service.list()).find((command) => command.id === 'help');
    const en = (await (await rig('', 'en')).service.list()).find(
      (command) => command.id === 'help',
    );
    expect(pt?.description).not.toBe(en?.description);
  });
});

describe('running a line', () => {
  it('a query answers with text and data and touches no Director', async () => {
    const { service, messages } = await rig();
    for (const line of [
      '/status',
      '/quota',
      '/cost',
      '/executors',
      '/plays',
      '/logs',
      '/doctor',
      '/export',
      '/model',
      '/effort',
      '/profile',
      '/directives',
      '/config',
      '/help',
    ]) {
      const name = line.slice(1);
      if (name === 'model' || name === 'effort') continue; // those need an Executor: tested below
      const result = await service.execute('project-1', { text: line });
      expect(result.status, line).toBe('done');
      expect(result.command).toBe(name);
      expect(result.text, line).not.toBe('');
    }
    expect(messages).toEqual([]);
  });

  it('/cost totals the usage and /status counts what is open', async () => {
    const { service, store } = await rig();
    await addPlay(store, 'play-1');
    const cost = await service.execute('project-1', { text: '/cost' });
    expect(cost.text).toContain('3');
    expect(cost.text).toContain('1.50');
    const status = await service.execute('project-1', { text: '/status' });
    expect(status.data).toMatchObject({ openPlays: 1, pendingDecisions: 0, director: 'none' });
  });

  it('/stop interrupts the reply of the Director, with no turn and no confirmation', async () => {
    const { service, interrupted, setInterruptible, messages } = await rig();
    const stopped = await service.execute('project-1', { text: '/stop' });
    expect(stopped).toMatchObject({ status: 'done', data: { stopped: true } });
    setInterruptible(false);
    const idle = await service.execute('project-1', { text: '/stop' });
    expect(idle).toMatchObject({ status: 'done', data: { stopped: false } });
    expect(interrupted).toEqual(['project-1', 'project-1']);
    expect(messages).toEqual([]);
    const listed = idsOf(await service.list({ scenarioId: 'project-1' }));
    expect(listed).toContain('stop');
  });

  it('/config reads a key of the configuration and refuses an unknown one', async () => {
    const { service } = await rig();
    const sections = await service.execute('project-1', { text: '/config' });
    expect(sections.text).toContain('chat');
    const key = await service.execute('project-1', { text: '/config chat.slash_logs_lines' });
    expect(key.data).toBe(20);
    await expect(
      service.execute('project-1', { text: '/config chat.nope' }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('/help lists the valid commands and describes one', async () => {
    const { service, store } = await rig();
    await addPlay(store, 'play-1');
    const all = await service.execute('project-1', { text: '/help' });
    expect(all.text).toContain('/status');
    expect(all.text).not.toContain('/resume');
    const one = await service.execute('project-1', { text: '/help cancel' });
    expect(one.text).toContain('/cancel');
    await expect(service.execute('project-1', { text: '/help resume' })).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('/cancel asks for a confirmation and cancels every open play once confirmed', async () => {
    const { service, store, sent } = await rig();
    await addPlay(store, 'play-1');
    await addPlay(store, 'play-2');
    const asked = await service.execute('project-1', { text: '/cancel' });
    expect(asked).toMatchObject({ status: 'confirm', command: 'cancel' });
    expect(sent).toEqual([]);
    const done = await service.execute('project-1', { text: '/cancel too slow', confirm: true });
    expect(done.status).toBe('done');
    expect(sent).toEqual([
      { playId: 'play-1', event: { type: 'CANCEL', reason: 'too slow' } },
      { playId: 'play-2', event: { type: 'CANCEL', reason: 'too slow' } },
    ]);
  });

  it('chat.slash_confirm: never runs /cancel at once', async () => {
    const { service, store, sent } = await rig('chat:\n  slash_confirm: never\n');
    await addPlay(store, 'play-1');
    expect((await service.execute('project-1', { text: '/cancel' })).status).toBe('done');
    expect(sent).toHaveLength(1);
    const listed = (await service.list({ scenarioId: 'project-1' })).find((c) => c.id === 'cancel');
    expect(listed?.confirm).toBe(false);
  });

  it('/pause and /resume go through the runner with pause.mode', async () => {
    const { service, store, sent } = await rig();
    await addPlay(store, 'play-1');
    await service.execute('project-1', { text: '/pause lunch' });
    expect(sent).toEqual([
      { playId: 'play-1', event: { type: 'PAUSE', mode: 'drain', reason: 'lunch' } },
    ]);
    await store.plays.update('play-1', { snapshot: pausedSnapshot });
    await service.execute('project-1', { text: '/resume' });
    expect(sent.at(-1)).toEqual({ playId: 'play-1', event: { type: 'RESUME' } });
  });

  it('refuses a command that is not valid now with a conflict that says why', async () => {
    const { service } = await rig();
    await expect(service.execute('project-1', { text: '/pause' })).rejects.toBeInstanceOf(Conflict);
    await expect(service.execute('chat-1', { text: '/plays' })).rejects.toBeInstanceOf(Conflict);
    await expect(service.execute('archived-1', { text: '/attach /tmp/x' })).rejects.toBeInstanceOf(
      Conflict,
    );
    await expect(service.execute('project-1', { text: '/pause' })).rejects.toThrow(/open play/);
  });

  it('refuses an unknown command and bad arguments', async () => {
    const { service } = await rig();
    await expect(service.execute('project-1', { text: '/nope' })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    await expect(service.execute('project-1', { text: '/status now' })).rejects.toThrow(
      /no arguments/,
    );
    await expect(service.execute('project-1', { text: '/logs many' })).rejects.toThrow(
      /Usage: \/logs/,
    );
    await expect(service.execute('project-1', { text: '/attach' })).rejects.toThrow(
      /Usage: \/attach/,
    );
    await expect(service.execute('nope', { text: '/status' })).rejects.toThrow(/no scenario/i);
  });

  it('/attach, /new and the templates reach the channel', async () => {
    const { service, attached, opened, messages } = await rig();
    expect((await service.execute('project-1', { text: '/attach /tmp/notes.md' })).data).toEqual({
      attachmentId: 'att-1',
    });
    expect(attached).toEqual(['/tmp/notes.md']);
    expect((await service.execute('project-1', { text: '/new Ideas' })).data).toEqual({
      scenarioId: 'chat-new',
    });
    expect(opened).toEqual(['Ideas']);
    const forwarded = await service.execute('project-1', { text: '/plan the login page' });
    expect(forwarded.status).toBe('forwarded');
    expect(messages).toEqual(['Make a plan, without changing anything yet, for: the login page']);
    await expect(service.execute('project-1', { text: '/plan' })).rejects.toThrow(/Usage: \/plan/);
  });

  it('/new project <repo> opens a project scenario through the same route as `ot chat --type project`', async () => {
    const { service, opened, openedInputs } = await rig();
    const result = await service.execute('chat-1', { text: '/new project /work/shop' });
    expect(result.data).toEqual({ scenarioId: 'project-new', type: 'project' });
    expect(result.text).toContain('shop');
    expect(openedInputs).toEqual([{ type: 'project', repo: '/work/shop' }]);
    expect(opened).toEqual(['/work/shop']);
    // The words after "project" are the repository, spaces and all.
    await service.execute('chat-1', { text: '/new project /work/my shop' });
    expect(openedInputs[1]).toEqual({ type: 'project', repo: '/work/my shop' });
    // A name that only starts with the word is still the name of a chat.
    await service.execute('chat-1', { text: '/new projects' });
    expect(openedInputs[2]).toEqual({ type: 'chat', name: 'projects' });
  });

  it('/new project says it needs the repository, and says a bad one in the catalog text', async () => {
    const { service, openedInputs } = await rig();
    await expect(service.execute('chat-1', { text: '/new project' })).rejects.toThrow(
      /needs the repository/,
    );
    await expect(service.execute('chat-1', { text: '/new project /not-a-repo' })).rejects.toThrow(
      /Could not open a project on "\/not-a-repo"/,
    );
    expect(openedInputs).toEqual([]);
    const pt = await rig('', 'pt-BR');
    await expect(pt.service.execute('chat-1', { text: '/new project' })).rejects.toThrow(
      /precisa do repositório/,
    );
    await expect(
      pt.service.execute('chat-1', { text: '/new project /not-a-repo' }),
    ).rejects.toThrow(/Não deu para abrir um projeto em "\/not-a-repo"/);
  });

  it('/logs shows the last events of the scenario', async () => {
    const { service, store } = await rig();
    for (let index = 0; index < 3; index += 1) {
      await store.events.append({
        type: 'chat.director_reply',
        schemaVersion: 1,
        scenarioId: 'project-1',
        payload: {},
      });
    }
    await store.events.append({
      type: 'chat.director_reply',
      schemaVersion: 1,
      scenarioId: 'chat-1',
      payload: {},
    });
    const logs = await service.execute('project-1', { text: '/logs 2' });
    expect((logs.data as unknown[]).length).toBe(2);
    expect(logs.text.split('\n')).toHaveLength(2);
  });

  it('the answers come in the language asked for', async () => {
    const { service } = await rig();
    const en = await service.execute('project-1', { text: '/status', lang: 'en' });
    const pt = await service.execute('project-1', { text: '/status', lang: 'pt-BR' });
    expect(pt.text).not.toBe(en.text);
  });
});

describe('chat.slash_commands and chat.slash_access', () => {
  it('off: the registry says it is off and a line is refused', async () => {
    const { service } = await rig('chat:\n  slash_commands: off\n');
    expect(service.enabled()).toBe(false);
    await expect(service.execute('project-1', { text: '/status' })).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  it('read_only: the commands that change things are refused and the queries still answer', async () => {
    const { service, store, sent, messages } = await rig('chat:\n  slash_access: read_only\n');
    await addPlay(store, 'play-1');
    expect((await service.execute('project-1', { text: '/status' })).status).toBe('done');
    for (const line of ['/pause', '/cancel', '/plan x', '/attach /tmp/x', '/new']) {
      await expect(
        service.execute('project-1', { text: line, confirm: true }),
        line,
      ).rejects.toBeInstanceOf(PermissionDenied);
    }
    expect(sent).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('chat.slash_templates adds, replaces and removes the templates', async () => {
    const { service, messages } = await rig(
      'chat:\n  slash_templates:\n    risks: "List the risks of: "\n    status: "never wins "\n',
    );
    const ids = idsOf(await service.list({ scenarioId: 'project-1' }));
    expect(ids).toContain('risks');
    expect(ids).not.toContain('plan'); // the record replaces the default one
    await service.execute('project-1', { text: '/risks the release' });
    expect(messages).toEqual(['List the risks of: the release']);
    // a template never takes the name of a command of the daemon
    expect((await service.execute('project-1', { text: '/status' })).command).toBe('status');
  });
});

describe('/director, /model and /effort (P14, N242)', () => {
  it('/director lists the Executors of the role with the one in force and what the client announces', async () => {
    const { service, switches } = await rig();
    const result = await service.execute('project-1', { text: '/director' });
    expect(result.status).toBe('done');
    expect(result.command).toBe('director');
    expect(result.text).toContain('fake-model@fake/one');
    expect(result.text).toContain('fake-model@fake/two');
    expect((result.data as { director: { executors: unknown[] } }).director.executors).toHaveLength(
      2,
    );
    expect(switches).toEqual([]);
  });

  it('/director <executor> and /director default switch through the Director sessions', async () => {
    const { service, switches } = await rig();
    const set = await service.execute('project-1', { text: '/director 2' });
    expect(set.data).toMatchObject({
      status: 'applied',
      override: { executor: 'fake-model@fake/two' },
    });
    const back = await service.execute('project-1', { text: '/director default' });
    expect(back.data).toMatchObject({ status: 'applied', override: null });
    expect(switches).toEqual([
      { scenarioId: 'project-1', change: { kind: 'set', executor: '2' } },
      { scenarioId: 'project-1', change: { kind: 'default' } },
    ]);
  });

  it('/model <m> and /effort <e> switch; without an argument they only read', async () => {
    const { service, switches } = await rig();
    await service.execute('project-1', { text: '/model fake-model-2' });
    await service.execute('project-1', { text: '/effort high' });
    expect(switches).toEqual([
      { scenarioId: 'project-1', change: { kind: 'set', model: 'fake-model-2' } },
      { scenarioId: 'project-1', change: { kind: 'set', effort: 'high' } },
    ]);
  });

  it('read_only: the switches are refused and the list still answers', async () => {
    const { service, switches } = await rig('chat:\n  slash_access: read_only\n');
    expect((await service.execute('project-1', { text: '/director' })).status).toBe('done');
    for (const line of ['/director 2', '/director default', '/model m', '/effort high']) {
      await expect(service.execute('project-1', { text: line }), line).rejects.toBeInstanceOf(
        PermissionDenied,
      );
    }
    expect(switches).toEqual([]);
  });

  it('is listed with the commands that apply to a scenario', async () => {
    const { service } = await rig();
    expect(idsOf(await service.list({ scenarioId: 'project-1' }))).toContain('director');
  });
});

describe('the commands of the client of the Director', () => {
  it('are listed with the prefix of the client and refused while the Director is in a turn', async () => {
    const { service, setDirector, messages } = await rig();
    setDirector(director({ inTurn: true }));
    const list = await service.list({ scenarioId: 'project-1' });
    expect(list.filter((c) => c.origin === 'client')).toEqual([
      expect.objectContaining({
        id: 'claude:compact',
        name: '/claude:compact',
        group: 'client',
        description: 'Compact the conversation',
        args: '<instructions>',
        descriptionKey: '',
      }),
      expect.objectContaining({ id: 'claude:review', name: '/claude:review' }),
    ]);
    await expect(
      service.execute('project-1', { text: '/claude:compact keep tests' }),
    ).rejects.toBeInstanceOf(Conflict);
    expect(messages).toEqual([]);
  });

  it('go to the Director with their own name when it is idle', async () => {
    const { service, setDirector, messages } = await rig();
    setDirector(director({}));
    const result = await service.execute('project-1', { text: '/claude:compact keep tests' });
    expect(result).toMatchObject({ status: 'forwarded', command: 'claude:compact' });
    expect(messages).toEqual(['/compact keep tests']);
    await service.execute('project-1', { text: '/claude:review' });
    expect(messages.at(-1)).toBe('/review');
  });

  it('wait for the first turn of the Director', async () => {
    const { service, setDirector } = await rig();
    setDirector(director({ started: false }));
    await expect(service.execute('project-1', { text: '/claude:compact' })).rejects.toBeInstanceOf(
      Conflict,
    );
  });

  it('are not offered without an open session, to an archived scenario or for a chat with no client', async () => {
    const { service, setDirector } = await rig();
    expect(
      (await service.list({ scenarioId: 'project-1' })).some((c) => c.origin === 'client'),
    ).toBe(false);
    await expect(service.execute('project-1', { text: '/claude:compact' })).rejects.toBeInstanceOf(
      Conflict,
    );
    setDirector(director({}));
    expect(
      (await service.list({ scenarioId: 'archived-1' })).some((c) => c.origin === 'client'),
    ).toBe(false);
    // no scenario: no client commands either
    expect((await service.list()).some((c) => c.origin === 'client')).toBe(false);
  });

  it('chat.client_commands: off hides them and refuses them', async () => {
    const { service, setDirector } = await rig('chat:\n  client_commands: off\n');
    setDirector(director({}));
    expect(
      (await service.list({ scenarioId: 'project-1' })).some((c) => c.origin === 'client'),
    ).toBe(false);
    await expect(service.execute('project-1', { text: '/claude:compact' })).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  it('chat.client_commands: allowlist keeps only the commands named in the allow list', async () => {
    const { service, setDirector, messages } = await rig(
      'chat:\n  client_commands: allowlist\n  client_commands_allow:\n    - /claude:review\n',
    );
    setDirector(director({}));
    expect(
      idsOf((await service.list({ scenarioId: 'project-1' })).filter((c) => c.origin === 'client')),
    ).toEqual(['claude:review']);
    await expect(service.execute('project-1', { text: '/claude:compact' })).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    await service.execute('project-1', { text: '/claude:review' });
    expect(messages).toEqual(['/review']);
  });
});
