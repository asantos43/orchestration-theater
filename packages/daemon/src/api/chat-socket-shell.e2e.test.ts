// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import {
  ChatServerMessageSchema,
  type ChatClientMessage,
  type ChatServerMessage,
} from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { dataPaths } from '../paths.js';

/**
 * The `!` command through the chat WebSocket (P6 of docs/18): the message runs in the worktree
 * and never reaches the Director, the two events carry no output, and the socket gets the started
 * and finished frames with the snippet. The clock of the daemon is fake, so the timeout is covered
 * by the unit tests of the service, with the real clock.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function withShellDaemon(
  extra: string,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    {
      extra: `api:
  chat:
    heartbeat: 30s
${extra}`,
    },
    body,
  );
}

/** A lean chat client: what the daemon sent, and a way to send. */
async function openChat(
  harness: PlayHarness,
  scenarioId: string,
): Promise<{
  readonly frames: ChatServerMessage[];
  send(message: ChatClientMessage): void;
  close(): void;
}> {
  const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
  const answer = await fetch(`${harness.daemon.api.url}/v1/chat-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId }),
  });
  expect(answer.status).toBe(200);
  const { ticket } = (await answer.json()) as { ticket: string };
  const socket = new WebSocket(
    `${harness.daemon.api.url.replace('http', 'ws')}/v1/scenarios/${scenarioId}/chat?ticket=${ticket}`,
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
  return {
    frames,
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    close: () => {
      socket.close(1000);
    },
  };
}

const promptsQueued = async (harness: PlayHarness): Promise<number> =>
  (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
    (event) => event.type === 'prompt.queued',
  ).length;

describeWithLauncher('the ! command through the chat WebSocket (P6)', { timeout: 120_000 }, () => {
  it('runs in the worktree, answers with the snippet and never reaches the Director', async () => {
    await withShellDaemon(
      `app:
  terminal: host
chat:
  shell_command:
    context: never
`,
      async (harness) => {
        const scenarioId = await harness.openGenericChat('shell');
        const chat = await openChat(harness, scenarioId);
        const queuedBefore = await promptsQueued(harness);

        chat.send({
          type: 'message',
          text: '!echo hello-from-shell; echo from "$(basename "$PWD")"',
        });
        const finished = await waitFor('the finished frame', () =>
          Promise.resolve(
            chat.frames.find(
              (frame): frame is Extract<ChatServerMessage, { type: 'shell_finished' }> =>
                frame.type === 'shell_finished',
            ),
          ),
        );
        const started = chat.frames.find((frame) => frame.type === 'shell_started');
        expect(started).toMatchObject({
          command: {
            place: 'host',
            command: expect.stringContaining('hello-from-shell') as unknown,
          },
        });
        expect(finished.snippet).toContain('hello-from-shell');
        expect(finished.result).toMatchObject({
          outcome: 'exited',
          exitCode: 0,
          askedInput: false,
          context: 'never',
        });
        // Started comes before finished, and each has the id of its event.
        expect(started?.eventId).toBeLessThan(finished.eventId);

        // The events say how it ended, not what it printed.
        const events = await harness.daemon.store.events.readFrom(0, 100_000);
        const shellEvents = events.filter((event) => event.type.startsWith('chat.shell_command.'));
        expect(shellEvents.map((event) => event.type)).toEqual([
          'chat.shell_command.started',
          'chat.shell_command.finished',
        ]);
        expect(JSON.stringify(shellEvents)).not.toContain('from-shell\\n');
        // It was not a prompt: the Director never saw the message.
        expect(await promptsQueued(harness)).toBe(queuedBefore);
        chat.close();
      },
    );
  });

  it('refuses with chat.shell_command: off, with an error frame, and runs nothing', async () => {
    await withShellDaemon(
      `app:
  terminal: host
chat:
  shell_command: off
`,
      async (harness) => {
        const scenarioId = await harness.openGenericChat('shell');
        const chat = await openChat(harness, scenarioId);
        chat.send({ type: 'message', text: '!echo nope', clientId: 'sh-7' });
        const error = await waitFor('the error frame', () =>
          Promise.resolve(
            chat.frames.find(
              (frame): frame is Extract<ChatServerMessage, { type: 'error' }> =>
                frame.type === 'error',
            ),
          ),
        );
        expect(error.error.code).toBe('forbidden');
        // N205: the refusal says it is of a `!` line, and which one.
        expect(error.error.details).toEqual({
          source: 'shell',
          command: 'echo nope',
          clientId: 'sh-7',
        });
        expect(chat.frames.some((frame) => frame.type === 'shell_started')).toBe(false);
        expect(
          (await harness.daemon.store.events.readFrom(0, 100_000)).some((event) =>
            event.type.startsWith('chat.shell_command.'),
          ),
        ).toBe(false);
        chat.close();
      },
    );
  });

  it("marks the question of context: ask as the shell's, in the input of the ask frame (N205)", async () => {
    await withShellDaemon(
      `app:
  terminal: host
chat:
  shell_command:
    context: ask
`,
      async (harness) => {
        const scenarioId = await harness.openGenericChat('shell');
        const chat = await openChat(harness, scenarioId);
        chat.send({ type: 'message', text: '!echo marked' });
        const ask = await waitFor('the ask frame', () =>
          Promise.resolve(
            chat.frames.find(
              (frame): frame is Extract<ChatServerMessage, { type: 'ask' }> => frame.type === 'ask',
            ),
          ),
        );
        expect(ask.input).toMatchObject({
          source: 'shell',
          shell: { command: 'echo marked', exitCode: 0, lines: 1 },
        });
        chat.close();
      },
    );
  });
});
