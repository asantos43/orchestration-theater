// SPDX-License-Identifier: MPL-2.0
import {
  AGENT_SESSION_PORT_VERSION,
  isOTheaterError,
  type AgentSession,
  type ConfigValue,
  type ContentBlock,
  type NormalizedUpdate,
  type PromptOutcome,
} from '@otheater/core';
import { describe, expect, it, type TestContext } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { realClientFlags, rejectionOf, settle, type ClientConformanceOptions } from './helpers.js';

/**
 * The prompts a suite needs. Each one must make the client do exactly this; the harness of a fake
 * or of the fake agent writes them as `#script:` directives, the harness of a real client as
 * natural language. A missing optional prompt skips the tests that need it.
 */
export interface AgentSessionPrompts {
  /** A turn that streams `text` back as agent message chunks and ends normally. */
  readonly echo: (text: string) => readonly ContentBlock[];
  /** A turn that does not end by itself: only `cancel` (or the end of the client) stops it. */
  readonly hang?: readonly ContentBlock[];
  /** A turn that fails with an error that is not a quota error. */
  readonly fail?: readonly ContentBlock[];
  /** A turn that fails because the quota is exhausted. */
  readonly quota?: readonly ContentBlock[];
}

export interface AgentSessionHarness extends Disposable {
  /** A session just opened on a client that is running. */
  readonly session: AgentSession;
  readonly prompts: AgentSessionPrompts;
  /**
   * How many processes of the client (the whole tree, not only the root) are still alive. Checked
   * after `cancel` and `close`: the contract says neither leaves a child behind.
   */
  readonly processesAlive: () => number | Promise<number>;
  /** A config option the client offers and a value it accepts, plus a value it does not. */
  readonly config?: {
    readonly valid: { readonly id: string; readonly value: ConfigValue };
    readonly invalidValue: { readonly id: string; readonly value: ConfigValue };
    readonly unknownId: string;
  };
  /** Opens the same conversation again (`loadSession`) after the session was closed; for clients that can load. */
  readonly reload?: () => Promise<AgentSession>;
  /** `loadSession` for a conversation the client does not have: the suite expects `NotFound`. */
  readonly reloadUnknown?: () => Promise<AgentSession>;
  /** Kills the client process the way a crash does (no `close`, no `cancel`). */
  readonly crash?: () => Promise<void>;
}

const text = (update: NormalizedUpdate): string =>
  update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';

/**
 * How a prompt ended, as a value. Attached right after `prompt` is called, so a turn that fails
 * while the test is still awaiting something else is never an unhandled rejection.
 */
function settledOf(
  promise: Promise<PromptOutcome>,
): Promise<{ readonly outcome: PromptOutcome } | { readonly error: unknown }> {
  return promise.then(
    (outcome) => ({ outcome }),
    (error: unknown) => ({ error }),
  );
}

/** A turn that was asked to hang is running once the client has started it; give it a moment. */
const untilRunning = settle;

/**
 * Registers the `AgentSession` conformance tests (port version {@link AGENT_SESSION_PORT_VERSION})
 * in the calling Vitest file. They check the whole JSDoc contract of `AgentSession`: one prompt at
 * a time, the updates before the answer, listeners that cannot break the session, typed errors, a
 * cancelled turn that is not an error, `cancel` that ends the process tree, `setConfig`, and
 * `close`. Call it at the top level of a test file, once per transport.
 *
 * With `{ real: true }` the suite is skipped unless `OT_TEST_REAL_CLIENTS=1`, and the tests that
 * send a prompt unless `OT_TEST_REAL_PROMPTS=1` too (a real client spends the quota of a real
 * account; nothing here starts one by itself).
 */
export function describeAgentSessionConformance(
  name: string,
  factory: AdapterFactory<AgentSessionHarness>,
  options: ClientConformanceOptions = {},
): void {
  const flags = realClientFlags();
  const real = options.real === true;
  const enabled = !real || flags.clients;
  const prompting = !real || flags.prompts;

  describe.skipIf(!enabled)(
    `AgentSession conformance: ${name} (port ${AGENT_SESSION_PORT_VERSION})`,
    () => {
      const harness = useHarness(factory);
      /** Skips the running test when the harness has no such prompt (a real client may have none). */
      const needs = <T>(ctx: TestContext, value: T | undefined): T => {
        if (value === undefined) ctx.skip();
        return value;
      };
      const promptTest = (title: string, body: (ctx: TestContext) => Promise<void>): void => {
        it.skipIf(!prompting)(title, body);
      };

      it('has a session id and says whether it can be reloaded', () => {
        const { session } = harness();
        expect(typeof session.sessionId).toBe('string');
        expect(session.sessionId.length).toBeGreaterThan(0);
        expect(typeof session.canLoad).toBe('boolean');
      });

      promptTest(
        'prompt resolves with a stop reason, after the updates reached the listener',
        async () => {
          const { session, prompts } = harness();
          const seen: string[] = [];
          session.onUpdate((update) => seen.push(text(update)));
          const outcome = await session.prompt(prompts.echo('alpha beta gamma'));
          expect(outcome.stopReason).toBe('end_turn');
          expect(seen.join('')).toContain('alpha beta gamma');
        },
      );

      promptTest('delivers the updates of the turn in order, to every listener', async () => {
        const { session, prompts } = harness();
        const first: string[] = [];
        const second: string[] = [];
        session.onUpdate((update) => first.push(text(update)));
        session.onUpdate((update) => second.push(text(update)));
        await session.prompt(prompts.echo('one two three four'));
        expect(first.join('')).toBe(second.join(''));
        expect(first.join('')).toContain('one two three four');
      });

      promptTest(
        'a listener that throws does not break the session or the other listeners',
        async () => {
          const { session, prompts } = harness();
          const seen: string[] = [];
          session.onUpdate(() => {
            throw new Error('listener bug');
          });
          session.onUpdate((update) => seen.push(text(update)));
          const outcome = await session.prompt(prompts.echo('still works'));
          expect(outcome.stopReason).toBe('end_turn');
          expect(seen.join('')).toContain('still works');
        },
      );

      promptTest('a disposed listener hears nothing more, and dispose is idempotent', async () => {
        const { session, prompts } = harness();
        const seen: string[] = [];
        const handle = session.onUpdate((update) => seen.push(text(update)));
        handle.dispose();
        handle.dispose();
        await session.prompt(prompts.echo('nobody listens'));
        expect(seen).toEqual([]);
      });

      promptTest('a second prompt while one runs rejects with Conflict', async (ctx) => {
        const { session, prompts } = harness();
        const hang = needs(ctx, prompts.hang);
        const running = settledOf(session.prompt(hang));
        await untilRunning();
        expect(await rejectionOf(session.prompt(prompts.echo('second')))).toMatchObject({
          code: 'CONFLICT',
        });
        await session.cancel();
        await running;
      });

      promptTest('a prompt can follow a finished one', async () => {
        const { session, prompts } = harness();
        await session.prompt(prompts.echo('one'));
        await expect(session.prompt(prompts.echo('two'))).resolves.toMatchObject({
          stopReason: 'end_turn',
        });
      });

      promptTest(
        'a failed turn rejects with a typed error and frees the session for the next prompt',
        async (ctx) => {
          const { session, prompts } = harness();
          const fail = needs(ctx, prompts.fail);
          const error = await rejectionOf(session.prompt(fail));
          expect(isOTheaterError(error)).toBe(true);
          const next = await session.prompt(prompts.echo('after the failure')).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(next).not.toMatchObject({ code: 'CONFLICT' });
        },
      );

      promptTest('an exhausted quota rejects with QuotaExhausted', async (ctx) => {
        const { session, prompts } = harness();
        const quota = needs(ctx, prompts.quota);
        expect(await rejectionOf(session.prompt(quota))).toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      });

      promptTest(
        'cancel ends a running turn as cancelled (not an error) and leaves no process',
        async (ctx) => {
          const h = harness();
          const hang = needs(ctx, h.prompts.hang);
          const running = h.session.prompt(hang);
          await untilRunning();
          await h.session.cancel();
          await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
          expect(await h.processesAlive()).toBe(0);
        },
      );

      promptTest('cancel is idempotent, also when called twice at once', async (ctx) => {
        const h = harness();
        const hang = needs(ctx, h.prompts.hang);
        const running = h.session.prompt(hang);
        await untilRunning();
        await Promise.all([h.session.cancel(), h.session.cancel()]);
        await h.session.cancel();
        await running;
        expect(await h.processesAlive()).toBe(0);
      });

      it('cancel with no turn running resolves and leaves no process', async () => {
        const h = harness();
        await h.session.cancel();
        expect(await h.processesAlive()).toBe(0);
      });

      it('after cancel the session is ended: every call rejects with AdapterUnavailable', async () => {
        const { session, prompts } = harness();
        await session.cancel();
        expect(await rejectionOf(session.prompt(prompts.echo('x')))).toMatchObject({
          code: 'ADAPTER_UNAVAILABLE',
        });
        expect(() => session.onUpdate(() => undefined)).toThrow(
          expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error,
        );
        await session.close();
      });

      it('setConfig accepts what the client offers and rejects the rest with InvalidInput', async (ctx) => {
        const { session, config } = harness();
        const known = needs(ctx, config);
        await session.setConfig(known.valid.id, known.valid.value);
        expect(
          await rejectionOf(session.setConfig(known.invalidValue.id, known.invalidValue.value)),
        ).toMatchObject({ code: 'INVALID_INPUT' });
        expect(await rejectionOf(session.setConfig(known.unknownId, 'x'))).toMatchObject({
          code: 'INVALID_INPUT',
        });
      });

      it('close resolves, is idempotent, and leaves no process', async () => {
        const h = harness();
        await Promise.all([h.session.close(), h.session.close()]);
        await h.session.close();
        expect(await h.processesAlive()).toBe(0);
      });

      it('after close every method rejects with AdapterUnavailable', async () => {
        const { session, prompts, config } = harness();
        await session.close();
        expect(await rejectionOf(session.prompt(prompts.echo('x')))).toMatchObject({
          code: 'ADAPTER_UNAVAILABLE',
        });
        expect(await rejectionOf(session.cancel())).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
        expect(
          await rejectionOf(session.setConfig(config?.valid.id ?? 'model', 'x')),
        ).toMatchObject({
          code: 'ADAPTER_UNAVAILABLE',
        });
        expect(() => session.onUpdate(() => undefined)).toThrow(
          expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error,
        );
      });

      promptTest('close during a turn ends the turn and leaves no process', async (ctx) => {
        const h = harness();
        const hang = needs(ctx, h.prompts.hang);
        const running = settledOf(h.session.prompt(hang));
        await untilRunning();
        await h.session.close();
        const settled = await running;
        if ('error' in settled) {
          expect(settled.error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
        } else {
          expect(settled.outcome.stopReason).toBe('cancelled');
        }
        expect(await h.processesAlive()).toBe(0);
      });

      promptTest(
        'a client that dies during a turn rejects it with AdapterUnavailable',
        async (ctx) => {
          const h = harness();
          const hang = needs(ctx, h.prompts.hang);
          const crash = needs(ctx, h.crash);
          const running = settledOf(h.session.prompt(hang));
          await untilRunning();
          await crash();
          expect(await running).toMatchObject({ error: { code: 'ADAPTER_UNAVAILABLE' } });
          expect(await rejectionOf(h.session.prompt(h.prompts.echo('x')))).toMatchObject({
            code: 'ADAPTER_UNAVAILABLE',
          });
          await h.session.close();
          expect(await h.processesAlive()).toBe(0);
        },
      );

      promptTest(
        'a conversation can be reloaded after close, when the client can load',
        async (ctx) => {
          const h = harness();
          const reload = needs(ctx, h.reload);
          if (!h.session.canLoad) ctx.skip();
          const id = h.session.sessionId;
          await h.session.close();
          const again = await reload();
          expect(again.sessionId).toBe(id);
          const seen: string[] = [];
          again.onUpdate((update) => seen.push(text(update)));
          await again.prompt(h.prompts.echo('back again'));
          expect(seen.join('')).toContain('back again');
          await again.close();
        },
      );

      it('reloading a conversation the client does not have rejects with NotFound', async (ctx) => {
        const h = harness();
        const reloadUnknown = needs(ctx, h.reloadUnknown);
        expect(await rejectionOf(reloadUnknown())).toMatchObject({ code: 'NOT_FOUND' });
        // Only the process of the session the harness opened may be left: the failed load added none.
        expect(await h.processesAlive()).toBeLessThanOrEqual(1);
      });
    },
  );
}
