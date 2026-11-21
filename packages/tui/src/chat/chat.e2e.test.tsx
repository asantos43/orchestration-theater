// SPDX-License-Identifier: MPL-2.0
import type { WebSocketConstructor } from '@otheater/client';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../ink.test-support.js';
import {
  assertFakeAgentBuilt,
  NO_LAUNCHER,
  waitUntil,
  withChatDaemon,
  type ChatDaemon,
  type ChatFakes,
} from './fake-agent.test-support.js';

/**
 * The acceptance of the chat (P12 of docs/18), against the real daemon with the fake agent: the TUI
 * of the Producer talks to the Director over the real `ChatSocket`. Nothing real runs (N57): the
 * daemon is in a temporary folder, on loopback, with a fake clock, a fake code host and the fake
 * agent in every role; no test reads a credential. The test is here and not in the daemon because
 * the daemon may not import the TUI (`tui-launcher-only-from-cli`). Timings are real and tolerant.
 */

beforeAll(assertFakeAgentBuilt);
afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };
const ENTER = '\r';
const ESC = '\x1b';

/** The play that goes all the way: a plan, two demands, the critique and the delivery as a PR. */
const APPROVED_PLAY = '#ot-play write alpha and beta #outcome:approved';
/** The play that runs out of attempts and waits for the Producer. */
const EXHAUSTED_PLAY = '#ot-play write alpha #outcome:exhausted';

function fakes(): ChatFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

/** The sockets the chat opened, so a test can drop the connection as a network that falls would. */
interface SocketRecorder {
  readonly Socket: WebSocketConstructor;
  readonly sockets: { readonly url: string; readonly sent: string[]; drop(): void }[];
}

function recordSockets(): SocketRecorder {
  const sockets: SocketRecorder['sockets'][number][] = [];
  class RecordingSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      const sent: string[] = [];
      const send = super.send.bind(this);
      this.send = (data) => {
        if (typeof data === 'string') sent.push(data);
        send(data);
      };
      sockets.push({
        url,
        sent,
        drop: () => {
          this.close(1000);
        },
      });
    }
  }
  return { Socket: RecordingSocket, sockets };
}

/** The TUI over the real daemon, with the chat ready (the socket is open and the Director listens). */
async function openTui(chat: ChatDaemon, socket?: SocketRecorder): Promise<RenderedApp> {
  const app = await renderApp({
    connector: chat.connector,
    size: SIZE,
    chatSocket: {
      initialDelayMs: 20,
      maxDelayMs: 50,
      jitter: 0,
      ...(socket === undefined ? {} : { webSocket: socket.Socket }),
    },
  });
  await waitUntil('the chat to be open', () => {
    const frame = app.frame();
    return Promise.resolve(
      frame.includes('Director active') && !frame.includes('connecting') ? frame : undefined,
    );
  });
  return app;
}

/** Types text into the box, a key at a time, as a person does. */
async function typeText(app: RenderedApp, text: string): Promise<void> {
  for (const char of text) {
    app.press(char);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await app.settle();
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Waits for the frame to show `text` (the real daemon is slower than a fake one). */
async function seen(app: RenderedApp, text: string): Promise<string> {
  return waitUntil(`the text "${text}" (last frame: ${app.frame()})`, () => {
    const frame = app.frame();
    return Promise.resolve(frame.includes(text) ? frame : undefined);
  });
}

describe.skipIf(NO_LAUNCHER)(
  'the chat of the TUI against the daemon with the fake agent (P12)',
  () => {
    it('a need asked in the chat becomes a play that runs to its delivery', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, APPROVED_PLAY);
        app.press(ENTER);
        // The Producer's own line is in the conversation, and the Director answers that it opened the play.
        await seen(app, 'write alpha and beta');
        await seen(app, 'opened:');
        const play = await waitUntil(
          'the play of the scenario',
          async () => (await daemon.plays())[0],
        );
        expect(play.need).toContain('write alpha and beta');
        await waitUntil('the play to be done', async () =>
          (await daemon.plays())[0]?.state === 'DONE' ? true : undefined,
        );
        expect(daemon.codeHost.pullRequests()).toHaveLength(1);
        // The conversation follows the play to its end, and the state line says the scenario is done.
        const frame = await seen(app, 'is now DONE');
        expect(frame).toContain('State: done');
      });
    }, 120_000);

    it('a decision of the play is answered by key and the play goes on', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, EXHAUSTED_PLAY);
        app.press(ENTER);
        await waitUntil('the play to wait for the Producer', async () =>
          (await daemon.plays())[0]?.state === 'AWAITING_PRODUCER' ? true : undefined,
        );
        const card = await seen(app, 'The play needs you');
        expect(card).toContain('Redefine the need');
        expect(card).toContain('Cancel the play');
        // The first option redefines the need: the card asks for the text, which is the answer.
        app.press('1');
        await seen(app, 'Type the answer');
        await typeText(app, 'write alpha and beta #outcome:approved');
        app.press(ENTER);
        // The answer is in the conversation, and the play leaves the wait and goes through its stages.
        await seen(app, 'Redefine the need: write alpha and beta');
        await waitUntil('the play to leave the wait', async () =>
          (await daemon.plays())[0]?.state !== 'AWAITING_PRODUCER' ? true : undefined,
        );
        await seen(app, 'is now PLANNING');
        const answered = (await daemon.events()).filter(
          (event) => event.type === 'decision.answered',
        );
        expect(answered.length).toBeGreaterThan(0);
        // The fake agent keeps the marker of the first need, so the play runs out again: a second
        // decision, answered by key as well, to end the play.
        await waitUntil('the play to wait again', async () =>
          (await daemon.plays())[0]?.state === 'AWAITING_PRODUCER' ? true : undefined,
        );
        await seen(app, 'The play needs you');
        app.press('3');
        await waitUntil('the play to be cancelled', async () =>
          (await daemon.plays())[0]?.state === 'CANCELLED' ? true : undefined,
        );
      });
    }, 120_000);

    it('a decision of the play is answered by the arrows and Enter: cancel ends the play', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, EXHAUSTED_PLAY);
        app.press(ENTER);
        await seen(app, 'The play needs you');
        // The menu ends with "Cancel the play": the arrow up from the first option wraps to the last.
        app.press('\x1b[A');
        await app.settle();
        app.press(ENTER);
        await waitUntil('the play to be cancelled', async () =>
          (await daemon.plays())[0]?.state === 'CANCELLED' ? true : undefined,
        );
      });
    }, 120_000);

    it('/status answers with no turn of the Director', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const app = await openTui(daemon);
        const before = (await daemon.events()).at(-1)?.id ?? 0;
        await typeText(app, '/status');
        app.press(ENTER);
        // The answer of the command is in the conversation, with the line of the Producer above it.
        const frame = await seen(app, 'Open plays: 0');
        expect(frame).toContain('/status');
        const events = (await daemon.events()).filter((event) => event.id > before);
        expect(events.filter((event) => event.type === 'prompt.queued')).toEqual([]);
        expect(app.frame()).not.toContain('Director in a turn');
      });
    }, 120_000);

    it('a drop of the socket comes back from the cursor, with no text lost or repeated', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const recorder = recordSockets();
        const app = await openTui(daemon, recorder);
        expect(recorder.sockets).toHaveLength(1);
        await typeText(app, '#ot-ask What color is the sky?');
        app.press(ENTER);
        await seen(app, 'What color is the sky?');
        // The question is on the card; the connection falls and comes back.
        await waitUntil('the card', () =>
          Promise.resolve(
            app.frame().includes('1.') || app.frame().includes('1 ') ? true : undefined,
          ),
        );
        recorder.sockets[0]?.drop();
        await waitUntil('a second socket', () =>
          Promise.resolve(recorder.sockets.length >= 2 ? true : undefined),
        );
        await waitUntil('the chat to be open again', () =>
          Promise.resolve(app.frame().includes('Reconnected') ? true : undefined),
        );
        // The second socket sent `resume` with the cursor, and the card was not drawn twice.
        const resume = recorder.sockets[1]?.sent.map(
          (line) => JSON.parse(line) as { type: string },
        );
        expect(resume?.some((frame) => frame.type === 'resume')).toBe(true);
        const frame = await app.settle();
        expect(count(frame, 'What color is the sky?')).toBeLessThanOrEqual(2);
        // The decision is still one: answering it by key gives one reply, once.
        const asks = (await daemon.events()).filter((event) => event.type === 'chat.ask');
        expect(asks).toHaveLength(1);
        app.press('1');
        const reply = await seen(app, 'answer:');
        expect(count(reply, 'answer:')).toBe(1);
        // A second drop right after the answer: the reply is not drawn again.
        recorder.sockets.at(-1)?.drop();
        await waitUntil('a third socket', () =>
          Promise.resolve(recorder.sockets.length >= 3 ? true : undefined),
        );
        await waitUntil('the third socket to be open', () =>
          Promise.resolve(count(app.frame(), 'Reconnected') >= 1 ? true : undefined),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(count(await app.settle(), 'answer:')).toBe(1);
      });
    }, 120_000);

    // ---- The `!` command (P18) -----------------------------------------------------------------

    const SHELL_ON = 'app:\n  terminal: host\n';

    it('!ls shows the command and its output in the conversation, and the line is not a message to the Director', async () => {
      // `never`: what the Director gets is not what this test is about.
      const never = `${SHELL_ON}chat:\n  shell_command:\n    context: never\n`;
      await withChatDaemon(fakes(), { extra: never }, async (daemon) => {
        const app = await openTui(daemon);
        const before = (await daemon.events()).at(-1)?.id ?? 0;
        await typeText(app, '!ls');
        app.press(ENTER);
        // The block of the command: its line, the output of the repository and how it ended.
        const frame = await seen(app, 'Finished with code 0');
        expect(frame).toContain('! ls');
        expect(frame).toContain('shared.txt');
        // The state line goes back to the Director, and the line of the box is not repeated as a message.
        expect(count(frame, '! ls')).toBe(1);
        expect(frame).toContain('Kept out of what the Director reads.');
        const events = (await daemon.events()).filter((event) => event.id > before);
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(['chat.shell_command.started', 'chat.shell_command.finished']),
        );
        expect(events.filter((event) => event.type === 'prompt.queued')).toEqual([]);
      });
    }, 120_000);

    it('a command in progress shows its state in the chat until it ends', async () => {
      await withChatDaemon(fakes(), { extra: SHELL_ON }, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, '!sleep 2; echo done-sleeping');
        app.press(ENTER);
        const running = await seen(app, 'Running in');
        expect(running).toContain('! sleep 2; echo done-sleeping');
        expect(running).toContain('running: ! sleep 2');
        const frame = await seen(app, 'Finished with code 0');
        expect(frame).toContain('done-sleeping');
        expect(frame).not.toContain('Running in');
        expect(frame).not.toContain('running: !');
      });
    }, 120_000);

    it('with context: ask, the TUI asks before the output goes to the Director', async () => {
      await withChatDaemon(
        fakes(),
        { extra: `${SHELL_ON}chat:\n  shell_command:\n    context: ask\n` },
        async (daemon) => {
          const app = await openTui(daemon);
          await typeText(app, '!ls');
          app.press(ENTER);
          const card = await seen(app, 'Send the output of ! ls to the Director?');
          // The words are the catalog's, not the English question of the daemon.
          expect(card).not.toContain('Send the result of');
          expect(card).toContain('Keep here');
          expect(card).toContain('shared.txt');
          const asks = (await daemon.events()).filter((event) => event.type === 'chat.ask');
          expect(asks).toHaveLength(1);
          // Nothing went to the Director while the question is open.
          expect((await daemon.events()).filter((e) => e.type === 'prompt.queued')).toEqual([]);
          app.press('1');
          await seen(app, 'Send');
          await waitUntil('the output to reach the Director', async () =>
            (await daemon.events()).some((event) => event.type === 'prompt.queued')
              ? true
              : undefined,
          );
        },
      );
    }, 120_000);

    it('with context: ask, Keep leaves the output out of the Director', async () => {
      await withChatDaemon(
        fakes(),
        { extra: `${SHELL_ON}chat:\n  shell_command:\n    context: ask\n` },
        async (daemon) => {
          const app = await openTui(daemon);
          await typeText(app, '!ls');
          app.press(ENTER);
          await seen(app, 'Send the output of ! ls to the Director?');
          app.press('2');
          await seen(app, 'Keep here');
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect((await daemon.events()).filter((e) => e.type === 'prompt.queued')).toEqual([]);
          expect(app.frame()).not.toContain('Send the output of');
        },
      );
    }, 120_000);

    it('a command that asks for input shows the warning', async () => {
      await withChatDaemon(fakes(), { extra: SHELL_ON }, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, "!printf 'Continue? '; read answer");
        app.press(ENTER);
        const frame = await seen(app, 'The command asked for input; it was not given.');
        expect(frame).toContain('Continue?');
      });
    }, 120_000);

    it('chat.shell_command: off shows the refusal', async () => {
      await withChatDaemon(
        fakes(),
        { extra: `${SHELL_ON}chat:\n  shell_command:\n    mode: off\n` },
        async (daemon) => {
          const app = await openTui(daemon);
          await typeText(app, '!ls');
          app.press(ENTER);
          const frame = await seen(app, 'The ! command is off');
          expect(frame).toContain('chat.shell_command');
          expect((await daemon.events()).filter((e) => e.type.startsWith('chat.shell'))).toEqual(
            [],
          );
        },
      );
    }, 120_000);

    it('Esc stops the reply of the Director and the play is not paused', async () => {
      await withChatDaemon(fakes(), {}, async (daemon) => {
        const app = await openTui(daemon);
        await typeText(app, APPROVED_PLAY);
        app.press(ENTER);
        await waitUntil('the play of the scenario', async () => (await daemon.plays())[0]);
        await typeText(app, '#ot-director-hang');
        app.press(ENTER);
        await seen(app, 'in a turn');
        app.press(ESC);
        await seen(app, 'Stopped the reply of the Director');
        // The play was not paused by the stop: it still reaches its end.
        await waitUntil('the play to be done', async () =>
          (await daemon.plays())[0]?.state === 'DONE' ? true : undefined,
        );
      });
    }, 120_000);
  },
);
