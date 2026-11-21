// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatServerMessageSchema, type ChatServerMessage } from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeWithLauncher } from '../../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from '../../orchestration/e2e-fixture.js';
import { dataPaths } from '../../paths.js';

/**
 * The registry of the `/` commands (Phase 7, P3) against the daemon with the fake agent in every
 * role (nothing real runs): the list that follows the scenario, a query that never reaches the
 * model, `/cancel` with its confirmation, the commands of the client of the Director (which the
 * fake agent announces after a `set_config_option`) and the same registry through the chat
 * WebSocket. The clock is a fake one; the client is the compiled `dist/cli.js` of the fake agent.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

type Send = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: Headers; text: string; json: any }>;

interface Rig {
  readonly harness: PlayHarness;
  readonly send: Send;
  readonly token: string;
  readonly stateDir: () => string;
}

function withSlashDaemon(
  options: { readonly extra?: string },
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  let stateDir = '';
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) => {
        stateDir = env.FAKE_AGENT_STATE_DIR ?? '';
        return new FakeClientAdapter({
          launcher,
          baseEnv: {},
          env: { ...env, FAKE_AGENT_UPDATES_ON_CONFIG: '1' },
          adapterVersion: '1.0.0',
          command,
        });
      },
    },
    { ...(options.extra === undefined ? {} : { extra: options.extra }) },
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const send: Send = async (method, path, payload, headers = {}) => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text, json: JSON.parse(text) };
      };
      await body({ harness, send, token, stateDir: () => stateDir });
    },
  );
}

const idsOf = (list: { commands: { id: string }[] }): string[] =>
  list.commands.map((command) => command.id);

const countOf = async (harness: PlayHarness, type: string): Promise<number> =>
  (await harness.daemon.store.events.readFrom(0, 100_000)).filter((event) => event.type === type)
    .length;

describeWithLauncher('the / commands with the fake agent (P3)', { timeout: 180_000 }, () => {
  it('lists what is valid for the scenario: it changes with the type, the state and the plays', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const noScenario = await send('GET', '/v1/commands');
      expect(noScenario.status, noScenario.text).toBe(200);
      expect(idsOf(noScenario.json)).toEqual(expect.arrayContaining(['help', 'quota', 'doctor']));
      expect(idsOf(noScenario.json)).not.toContain('status');

      const project = await harness.openChat();
      const chat = await harness.openGenericChat('talk');
      const forProject = await send('GET', `/v1/commands?scenario=${project}`);
      const forChat = await send('GET', `/v1/commands?scenario=${chat}`);
      expect(idsOf(forProject.json)).toEqual(expect.arrayContaining(['status', 'plays', 'logs']));
      expect(idsOf(forChat.json)).toContain('status');
      expect(idsOf(forChat.json)).not.toContain('plays');
      // no open play yet: nothing to cancel
      expect(idsOf(forProject.json)).not.toContain('cancel');
      expect(forProject.json.commands[0]).toMatchObject({
        origin: expect.any(String),
        description: expect.any(String),
      });

      await harness.producer.send(project, '#ot-play write alpha #actor-hang:alpha@1');
      await waitFor('the play', async () => (await harness.plays(project))[0]);
      const running = await send('GET', `/v1/commands?scenario=${project}`);
      expect(idsOf(running.json)).toEqual(expect.arrayContaining(['pause', 'cancel']));
      expect(idsOf(running.json)).not.toContain('resume');

      // the language of the answer follows `lang`
      const pt = await send('GET', `/v1/commands?scenario=${project}&lang=pt-BR`);
      const cancelEn = running.json.commands.find((c: any) => c.id === 'cancel');
      const cancelPt = pt.json.commands.find((c: any) => c.id === 'cancel');
      expect(cancelPt.description).not.toBe(cancelEn.description);

      const missing = await send('GET', '/v1/commands?scenario=nope');
      expect(missing.status).toBe(404);
    });
  });

  it('a query command answers without a turn of the Director', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const before = {
        queued: await countOf(harness, 'prompt.queued'),
        replies: await countOf(harness, 'chat.director_reply'),
      };
      for (const [index, line] of [
        '/status',
        '/quota',
        '/cost',
        '/executors',
        '/logs 5',
        '/help',
        '/doctor',
      ].entries()) {
        const answer = await send('POST', `/v1/scenarios/${scenarioId}/commands`, { text: line }, {
          'idempotency-key': `q-${String(index)}`,
        });
        expect(answer.status, `${line}: ${answer.text}`).toBe(200);
        expect(answer.json).toMatchObject({ status: 'done', command: line.slice(1).split(' ')[0] });
        expect(answer.json.text).not.toBe('');
      }
      // the same key answers the same, without running again
      const again = await send(
        'POST',
        `/v1/scenarios/${scenarioId}/commands`,
        { text: '/status' },
        { 'idempotency-key': 'q-0' },
      );
      expect(again.headers.get('idempotency-replayed')).toBe('true');

      expect(await countOf(harness, 'prompt.queued')).toBe(before.queued);
      expect(await countOf(harness, 'chat.director_reply')).toBe(before.replies);
      expect(await harness.daemon.store.promptQueue.list({ scenarioId })).toEqual([]);
    });
  });

  it('refuses an unknown command (400), one that is not valid now (409) and a missing scenario (404)', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const url = `/v1/scenarios/${scenarioId}/commands`;
      expect((await send('POST', url, { text: '/nope' })).status).toBe(400);
      expect((await send('POST', url, { text: 'no slash' })).status).toBe(400);
      const conflict = await send('POST', url, { text: '/pause' });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error.code).toBe('conflict');
      expect((await send('POST', '/v1/scenarios/nope/commands', { text: '/status' })).status).toBe(
        404,
      );
    });
  });

  it('/cancel asks for a confirmation and cancels the play once confirmed', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-play write alpha #actor-hang:alpha@1');
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
      await waitFor('alpha to be executing', async () =>
        (await harness.daemon.store.attempts.get(`${play.id}/alpha/1`))?.state === 'executing'
          ? true
          : undefined,
      );
      const url = `/v1/scenarios/${scenarioId}/commands`;

      const asked = await send('POST', url, { text: '/cancel changed my mind' });
      expect(asked.status, asked.text).toBe(200);
      expect(asked.json).toMatchObject({ status: 'confirm', command: 'cancel' });
      // nothing happened yet
      expect((await harness.daemon.store.plays.get(play.id))?.state).toBe('EXECUTING');

      const done = await send('POST', url, { text: '/cancel changed my mind', confirm: true });
      expect(done.status, done.text).toBe(200);
      expect(done.json).toMatchObject({ status: 'done', command: 'cancel' });
      await waitFor('the play to be cancelled', async () =>
        (await harness.daemon.store.plays.get(play.id))?.state === 'CANCELLED' ? true : undefined,
      );
    });
  });

  it('chat.slash_access: read_only refuses what changes things (403) and still answers a query', async () => {
    await withSlashDaemon({ extra: 'chat:\n  slash_access: read_only' }, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const url = `/v1/scenarios/${scenarioId}/commands`;
      expect((await send('POST', url, { text: '/status' })).status).toBe(200);
      const refused = await send('POST', url, { text: '/plan a thing' });
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe('forbidden');
    });
  });

  it('chat.slash_commands: off empties the list and refuses a line', async () => {
    await withSlashDaemon({ extra: 'chat:\n  slash_commands: off' }, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const list = await send('GET', `/v1/commands?scenario=${scenarioId}`);
      expect(list.status).toBe(200);
      expect(list.json.commands).toEqual([]);
      const refused = await send('POST', `/v1/scenarios/${scenarioId}/commands`, { text: '/status' });
      expect(refused.status).toBe(403);
    });
  });

  it('a template of the Director becomes a message of the Producer in the prompt queue', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const answer = await send('POST', `/v1/scenarios/${scenarioId}/commands`, {
        text: '/explain #ot-chat the sky',
      });
      expect(answer.status, answer.text).toBe(200);
      expect(answer.json.status).toBe('forwarded');
      await waitFor('the reply of the Director', async () =>
        (await harness.producer.poll(scenarioId, 0)).replies.length > 0 ? true : undefined,
      );
      expect(await countOf(harness, 'prompt.queued')).toBeGreaterThan(0);
    });
  });

  describe('the commands of the client of the Director', () => {
    const clientNames = (list: { commands: { id: string; origin: string }[] }): string[] =>
      list.commands.filter((c) => c.origin === 'client').map((c) => c.id);

    it('are listed after the first turn, go to the Director when it is idle and never to an Actor', async () => {
      await withSlashDaemon({}, async ({ harness, send }) => {
        const scenarioId = await harness.openGenericChat('talk');
        const url = `/v1/scenarios/${scenarioId}/commands`;
        // before the first turn of the Director its client is not known to take a command: conflict
        expect((await send('POST', url, { text: '/fake:fake-command' })).status).toBe(409);

        await harness.producer.send(scenarioId, '#ot-chat first');
        await waitFor('the first reply', async () =>
          (await harness.producer.poll(scenarioId, 0)).replies.length > 0 ? true : undefined,
        );
        const names = await waitFor('the client commands', async () => {
          const names = clientNames((await send('GET', `/v1/commands?scenario=${scenarioId}`)).json);
          return names.length > 0 ? names : undefined;
        });
        expect(names).toEqual(['fake:fake-command']);

        const sent = await send('POST', url, { text: '/fake:fake-command now' });
        expect(sent.status, sent.text).toBe(200);
        expect(sent.json).toMatchObject({ status: 'forwarded', command: 'fake:fake-command' });
        // it went to the Director as a message of the Producer, with the native name
        const queue = await harness.daemon.store.promptQueue.list({ scenarioId });
        expect(JSON.stringify(queue)).toContain('/fake-command now');
      });
    });

    it('are refused with a conflict while the Director is in a turn', async () => {
      await withSlashDaemon({}, async ({ harness, send, stateDir }) => {
        const scenarioId = await harness.openGenericChat('talk');
        const url = `/v1/scenarios/${scenarioId}/commands`;
        await harness.producer.send(scenarioId, '#ot-chat warm up');
        await waitFor('the first reply', async () =>
          (await harness.producer.poll(scenarioId, 0)).replies.length > 0 ? true : undefined,
        );
        await waitFor('the client commands', async () =>
          (await send('GET', `/v1/commands?scenario=${scenarioId}`)).json.commands.some(
            (c: any) => c.origin === 'client',
          )
            ? true
            : undefined,
        );

        await harness.producer.send(scenarioId, '#ot-director-hang\n#ot-chat hello');
        await waitFor('the turn to hang', () =>
          Promise.resolve(existsSync(join(stateDir(), 'director-hang.count')) || undefined),
        );
        const refused = await send('POST', url, { text: '/fake:fake-command' });
        expect(refused.status, refused.text).toBe(409);
        expect(refused.json.error.code).toBe('conflict');
        // the daemon commands still answer while the Director works
        expect((await send('POST', url, { text: '/status' })).status).toBe(200);
      });
    });

    it('chat.client_commands: off hides them and refuses them (403)', async () => {
      await withSlashDaemon({ extra: 'chat:\n  client_commands: off' }, async ({ harness, send }) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-chat first');
        await waitFor('the first reply', async () =>
          (await harness.producer.poll(scenarioId, 0)).replies.length > 0 ? true : undefined,
        );
        const list = await send('GET', `/v1/commands?scenario=${scenarioId}`);
        expect(list.json.commands.some((c: any) => c.origin === 'client')).toBe(false);
        const refused = await send('POST', `/v1/scenarios/${scenarioId}/commands`, {
          text: '/fake:fake-command',
        });
        expect(refused.status).toBe(403);
      });
    });
  });

  it('the chat WebSocket sends a command to the registry and answers with command_result', async () => {
    await withSlashDaemon({}, async ({ harness, send }) => {
      const scenarioId = await harness.openGenericChat('talk');
      const ticket = await send('POST', '/v1/chat-tickets', { scenarioId });
      expect(ticket.status, ticket.text).toBe(200);
      const socket = new WebSocket(
        `${harness.daemon.api.url.replace('http', 'ws')}/v1/scenarios/${scenarioId}/chat?ticket=${ticket.json.ticket}`,
      );
      const frames: ChatServerMessage[] = [];
      socket.addEventListener('message', (event) => {
        frames.push(ChatServerMessageSchema.parse(JSON.parse(String(event.data))));
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve();
        });
        socket.addEventListener('error', () => {
          reject(new Error('the chat socket did not open'));
        });
      });
      const before = await countOf(harness, 'prompt.queued');
      socket.send(JSON.stringify({ type: 'command', text: '/status' }));
      const result = await waitFor('the command result', async () =>
        frames.find((frame) => frame.type === 'command_result'),
      );
      expect(result).toMatchObject({
        type: 'command_result',
        eventId: null,
        result: { status: 'done', command: 'status' },
      });
      socket.send(JSON.stringify({ type: 'command', text: '/nope' }));
      const error = await waitFor('the error', async () =>
        frames.find((frame) => frame.type === 'error'),
      );
      expect(error).toMatchObject({ error: { code: 'invalid_input' } });
      // a query never reaches the Director
      expect(await countOf(harness, 'prompt.queued')).toBe(before);
      socket.close(1000);
    });
  });
});
