// SPDX-License-Identifier: MPL-2.0
import {
  CLIENT_ADAPTER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  type ClientAdapterContract,
  type ContentBlock,
  type NormalizedUpdate,
  type Profile,
  type RolePolicy,
  type SandboxCapabilities,
  type SharedCancelMode,
  type SessionTransport,
} from '@otheater/core';
import { describe, expect, it, type TestContext } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { realClientFlags, rejectionOf, settle, type ClientConformanceOptions } from './helpers.js';

export interface ClientAdapterHarness extends Disposable {
  readonly adapter: ClientAdapterContract;
  /** The transport the adapter opens its sessions through. */
  readonly via: SessionTransport;
  readonly profile: Profile;
  /** A policy the adapter can open (every field with enough layers for its `security` setting). */
  readonly policy: RolePolicy;
  /** Absolute path of a worktree the client may work in. */
  readonly cwd: string;
  readonly prompts: {
    readonly echo: (text: string) => readonly ContentBlock[];
    /** A turn that does not end by itself. */
    readonly hang?: readonly ContentBlock[];
    /** A turn that does not end by itself and ignores `session/cancel` (a client that is deaf to it). */
    readonly deaf?: readonly ContentBlock[];
  };
  /**
   * What cancelling a session does to a process that runs other sessions too (N64): the mode the
   * adapter was built with. Default `escalate`. Only read for an adapter that declares
   * `multi-session`.
   */
  readonly sharedCancel?: SharedCancelMode;
  /**
   * A prompt that makes the client ask permission to edit a file, and what happened to the file:
   * `granted()` is true when the edit went through. The policy rejects every request, so it must
   * stay false.
   */
  readonly permission?: {
    readonly prompt: readonly ContentBlock[];
    readonly granted: () => boolean | Promise<boolean>;
  };
  /** How many processes of the client are alive, the whole tree. Checked after `close` and `cancel`. */
  readonly processesAlive: () => number | Promise<number>;
  /** An id the client has no conversation for; `loadSession` must reject with `NotFound`. */
  readonly unknownSessionId?: string;
  /**
   * How many client processes (the roots, not their children) are alive. For an adapter that
   * declares `multi-session` the suite checks that two sessions share one.
   */
  readonly rootProcessesAlive?: () => number | Promise<number>;
  /** Kills every client process the way a crash does (no `close`, no `cancel`). */
  readonly crash?: () => Promise<void>;
  /**
   * The modes the adapter vetoes (the hook `modeVeto` of the base: `bypass` is the daemon's, so a
   * mode that would skip layer 2 never reaches the client), and what the transport has been asked
   * to apply, as the values of the config options. When given, the suite opens a session and
   * checks that `setConfig('mode', <vetoed>)` rejects with `PERMISSION_DENIED` and that none of
   * them reaches the transport.
   */
  readonly modeVeto?: {
    readonly modes: readonly string[];
    readonly applied: () => readonly unknown[];
  };
}

const text = (update: NormalizedUpdate): string =>
  update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';

const NO_OS: SandboxCapabilities = { fields: [] };
const ALL_OS: SandboxCapabilities = { fields: ROLE_POLICY_FIELDS };

/**
 * Registers the `ClientAdapter` conformance tests (port version
 * {@link CLIENT_ADAPTER_PORT_VERSION}) in the calling Vitest file: identity, `openSession` and
 * `loadSession`, the pure `guarantee`, `checkConformance`, the refusal of permission requests, the
 * catalog-probe session that never runs a prompt, and the end of the process tree. Call it at the
 * top level of a test file, once per adapter and transport.
 *
 * With `{ real: true }` the suite is skipped unless `OT_TEST_REAL_CLIENTS=1`, and the tests that
 * send a prompt unless `OT_TEST_REAL_PROMPTS=1` too; nothing here starts a real client by itself.
 */
export function describeClientAdapterConformance(
  name: string,
  factory: AdapterFactory<ClientAdapterHarness>,
  options: ClientConformanceOptions = {},
): void {
  const flags = realClientFlags();
  const real = options.real === true;
  const enabled = !real || flags.clients;
  const prompting = !real || flags.prompts;

  describe.skipIf(!enabled)(
    `ClientAdapter conformance: ${name} (port ${CLIENT_ADAPTER_PORT_VERSION})`,
    () => {
      const harness = useHarness(factory);
      const promptTest = (title: string, body: (ctx: TestContext) => Promise<void>): void => {
        it.skipIf(!prompting)(title, body);
      };

      it('identifies itself as a ClientAdapter of this port version', () => {
        const { adapter } = harness();
        expect(adapter.id).not.toBe('');
        expect(adapter.implements.port).toBe('ClientAdapter');
        expect(adapter.implements.range).toBe(`^${CLIENT_ADAPTER_PORT_VERSION}`);
        expect(['process-per-session', 'multi-session']).toContain(adapter.processModel);
      });

      it('announces its capabilities', () => {
        const { capabilities } = harness().adapter;
        expect(typeof capabilities.loadSession).toBe('boolean');
        expect(typeof capabilities.mcpHttp).toBe('boolean');
        expect(typeof capabilities.headless).toBe('boolean');
        expect(Array.isArray(capabilities.configOptions)).toBe(true);
        expect(Array.isArray(capabilities.extensions)).toBe(true);
      });

      it('has a quota probe and a model catalog', () => {
        const { adapter } = harness();
        expect(adapter.quota.id).not.toBe('');
        expect(adapter.models.discovery).not.toBe('');
      });

      describe('guarantee', () => {
        it('reports every field of the policy, and is consistent with itself', () => {
          const { adapter, policy } = harness();
          for (const os of [NO_OS, ALL_OS]) {
            const report = adapter.guarantee(policy, os);
            expect(Object.keys(report.fields).sort()).toEqual([...ROLE_POLICY_FIELDS].sort());
            for (const field of ROLE_POLICY_FIELDS) {
              const entry = report.fields[field];
              expect(entry.ok).toBe(entry.layers.length >= entry.required);
              expect(new Set(entry.layers).size).toBe(entry.layers.length);
            }
            const short = ROLE_POLICY_FIELDS.filter((field) => !report.fields[field].ok);
            expect([...report.short].sort()).toEqual([...short].sort());
            expect(report.ok).toBe(short.length === 0);
          }
        });

        it('is pure: the same input gives an equal answer, and the input is not changed', () => {
          const { adapter, policy } = harness();
          const before = JSON.stringify(policy);
          expect(adapter.guarantee(policy, NO_OS)).toEqual(adapter.guarantee(policy, NO_OS));
          expect(JSON.stringify(policy)).toBe(before);
        });

        it('a sandbox only adds layers, never takes one away', () => {
          const { adapter, policy } = harness();
          const without = adapter.guarantee(policy, NO_OS);
          const withOs = adapter.guarantee(policy, ALL_OS);
          for (const field of ROLE_POLICY_FIELDS) {
            expect(withOs.fields[field].layers.length).toBeGreaterThanOrEqual(
              without.fields[field].layers.length,
            );
            for (const layer of without.fields[field].layers) {
              expect(withOs.fields[field].layers).toContain(layer);
            }
            if (without.fields[field].ok) expect(withOs.fields[field].ok).toBe(true);
          }
        });
      });

      describe('checkConformance', () => {
        it('reports the adapter version and an ok that follows the probes', async () => {
          const { adapter, profile } = harness();
          const report = await adapter.checkConformance(profile);
          expect(report.adapterVersion).not.toBe('');
          expect(report.ok).toBe(report.probes.every((probe) => probe.ok));
          const ids = report.probes.map((probe) => probe.id);
          expect(new Set(ids).size).toBe(ids.length);
        });

        it('gives an equal report when asked again, also when asked at once', async () => {
          const { adapter, profile } = harness();
          const [first, second] = await Promise.all([
            adapter.checkConformance(profile),
            adapter.checkConformance(profile),
          ]);
          expect(second).toEqual(first);
          expect(await adapter.checkConformance(profile)).toEqual(first);
        });
      });

      promptTest(
        'openSession returns a session that answers a prompt, and close leaves no process',
        async () => {
          const h = harness();
          const session = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
          expect(session.sessionId).not.toBe('');
          const seen: string[] = [];
          session.onUpdate((update) => seen.push(text(update)));
          const outcome = await session.prompt(h.prompts.echo('hello adapter'));
          expect(outcome.stopReason).toBe('end_turn');
          expect(seen.join('')).toContain('hello adapter');
          await session.close();
          expect(await h.processesAlive()).toBe(0);
        },
      );

      it('two sessions are two clients: closing one leaves the other working', async () => {
        const h = harness();
        const first = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        const second = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        await first.close();
        if (prompting) {
          await expect(second.prompt(h.prompts.echo('still here'))).resolves.toMatchObject({
            stopReason: 'end_turn',
          });
        }
        await second.close();
        expect(await h.processesAlive()).toBe(0);
      });

      it('a catalog-probe session reads its config options and refuses to run anything', async () => {
        const h = harness();
        const session = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via, {
          purpose: 'catalog-probe',
        });
        const seen: string[] = [];
        session.onUpdate((update) => seen.push(text(update)));
        expect(session.sessionId).not.toBe('');
        expect(Array.isArray(session.configOptions)).toBe(true);
        expect(await rejectionOf(session.prompt(h.prompts.echo('must not run')))).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(await rejectionOf(session.setConfig('model', 'anything'))).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(seen).toEqual([]);
        await session.close();
        expect(await h.processesAlive()).toBe(0);
      });

      it('refuses a vetoed mode on the open session, before it reaches the client', async (ctx: TestContext) => {
        const h = harness();
        const veto = h.modeVeto;
        if (veto === undefined || veto.modes.length === 0) ctx.skip();
        const session = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        for (const mode of veto.modes) {
          expect(await rejectionOf(session.setConfig('mode', mode))).toMatchObject({
            code: 'PERMISSION_DENIED',
          });
          expect(veto.applied()).not.toContain(mode);
        }
        await session.close();
        expect(await h.processesAlive()).toBe(0);
      });

      it('loadSession reopens a conversation, or says it cannot', async (ctx: TestContext) => {
        const h = harness();
        const first = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        const id = first.sessionId;
        await first.close();
        if (!h.adapter.capabilities.loadSession) {
          expect(
            await rejectionOf(h.adapter.loadSession(h.profile, h.policy, h.cwd, id, h.via)),
          ).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
          return;
        }
        if (!first.canLoad) ctx.skip();
        const again = await h.adapter.loadSession(h.profile, h.policy, h.cwd, id, h.via);
        expect(again.sessionId).toBe(id);
        await again.close();
        expect(await h.processesAlive()).toBe(0);
      });

      it('loadSession of a conversation the client does not have rejects with NotFound', async (ctx: TestContext) => {
        const h = harness();
        if (h.unknownSessionId === undefined || !h.adapter.capabilities.loadSession) ctx.skip();
        expect(
          await rejectionOf(
            h.adapter.loadSession(h.profile, h.policy, h.cwd, h.unknownSessionId ?? '', h.via),
          ),
        ).toMatchObject({ code: 'NOT_FOUND' });
        expect(await h.processesAlive()).toBe(0);
      });

      describe('multi-session (declared by the adapter)', () => {
        /** Two sessions of the adapter; skips when the adapter runs one process per session. */
        const pair = async (ctx: TestContext) => {
          const h = harness();
          if (h.adapter.processModel !== 'multi-session') ctx.skip();
          const a = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
          const b = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
          return { h, a, b };
        };

        it('two sessions share one process and have ids of their own', async (ctx) => {
          const { h, a, b } = await pair(ctx);
          expect(b.sessionId).not.toBe(a.sessionId);
          if (h.rootProcessesAlive !== undefined) expect(await h.rootProcessesAlive()).toBe(1);
          await a.close();
          await b.close();
          expect(await h.processesAlive()).toBe(0);
        });

        promptTest('each session has a stream of its own', async (ctx) => {
          const { h, a, b } = await pair(ctx);
          const seenA: string[] = [];
          const seenB: string[] = [];
          a.onUpdate((update) => seenA.push(text(update)));
          b.onUpdate((update) => seenB.push(text(update)));
          await Promise.all([
            a.prompt(h.prompts.echo('only-for-alpha')),
            b.prompt(h.prompts.echo('only-for-beta')),
          ]);
          expect(seenA.join('')).toContain('only-for-alpha');
          expect(seenA.join('')).not.toContain('only-for-beta');
          expect(seenB.join('')).toContain('only-for-beta');
          expect(seenB.join('')).not.toContain('only-for-alpha');
          await a.close();
          await b.close();
          expect(await h.processesAlive()).toBe(0);
        });

        it('closing one session keeps the process for the other; the last close ends it', async (ctx) => {
          const { h, a, b } = await pair(ctx);
          await a.close();
          if (h.rootProcessesAlive !== undefined) expect(await h.rootProcessesAlive()).toBe(1);
          if (prompting) {
            await expect(b.prompt(h.prompts.echo('still here'))).resolves.toMatchObject({
              stopReason: 'end_turn',
            });
          }
          await b.close();
          expect(await h.processesAlive()).toBe(0);
        });

        promptTest('cancel of one session does not touch the other', async (ctx) => {
          const { h, a, b } = await pair(ctx);
          const hang = h.prompts.hang;
          // `always_kill` ends the shared process on every cancel; that mode has its own test below.
          if (hang === undefined || h.sharedCancel === 'always_kill') ctx.skip();
          const runningA = a.prompt(hang ?? []);
          const runningB = b.prompt(hang ?? []);
          let otherEnded = false;
          void runningB.then(
            () => {
              otherEnded = true;
            },
            () => {
              otherEnded = true;
            },
          );
          await settle();
          await a.cancel();
          await expect(runningA).resolves.toMatchObject({ stopReason: 'cancelled' });
          await settle();
          expect(otherEnded).toBe(false);
          if (h.rootProcessesAlive !== undefined) expect(await h.rootProcessesAlive()).toBe(1);
          await b.cancel();
          await expect(runningB).resolves.toMatchObject({ stopReason: 'cancelled' });
          expect(await h.processesAlive()).toBe(0);
        });

        describe('cancel of a session on a shared process (shared_cancel)', () => {
          const ended = (promise: Promise<unknown>): Promise<unknown> =>
            promise.then(
              () => undefined,
              (error: unknown) => error,
            );

          promptTest(
            'a cancel the client ignores ends the process in escalate and always_kill, not in release',
            async (ctx) => {
              const { h, a, b } = await pair(ctx);
              const { deaf, hang } = h.prompts;
              if (deaf === undefined || hang === undefined) ctx.skip();
              const mode = h.sharedCancel ?? 'escalate';
              const runningA = a.prompt(deaf ?? []);
              const runningB = ended(b.prompt(hang ?? []));
              await settle();
              await a.cancel();
              await expect(runningA).resolves.toMatchObject({ stopReason: 'cancelled' });
              if (mode === 'release') {
                await settle();
                if (h.rootProcessesAlive !== undefined) {
                  expect(await h.rootProcessesAlive()).toBe(1);
                }
                await b.cancel();
                expect(await runningB).toBeUndefined();
              } else {
                expect(await runningB).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
                expect(await h.processesAlive()).toBe(0);
              }
              await a.close();
              await b.close();
              expect(await h.processesAlive()).toBe(0);
            },
          );

          promptTest(
            'a cancel the client honours ends the process only in always_kill',
            async (ctx) => {
              const { h, a, b } = await pair(ctx);
              const hang = h.prompts.hang;
              if (hang === undefined) ctx.skip();
              const mode = h.sharedCancel ?? 'escalate';
              const runningA = a.prompt(hang ?? []);
              const runningB = ended(b.prompt(hang ?? []));
              await settle();
              await a.cancel();
              await expect(runningA).resolves.toMatchObject({ stopReason: 'cancelled' });
              if (mode === 'always_kill') {
                expect(await runningB).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
                expect(await h.processesAlive()).toBe(0);
              } else {
                await settle();
                if (h.rootProcessesAlive !== undefined) {
                  expect(await h.rootProcessesAlive()).toBe(1);
                }
                await b.cancel();
                expect(await runningB).toBeUndefined();
              }
              await a.close();
              await b.close();
              expect(await h.processesAlive()).toBe(0);
            },
          );
        });

        promptTest(
          'the death of the process drops both sessions with a typed error',
          async (ctx) => {
            const { h, a, b } = await pair(ctx);
            const hang = h.prompts.hang;
            if (hang === undefined || h.crash === undefined) ctx.skip();
            const ended = (promise: Promise<unknown>): Promise<unknown> =>
              promise.then(
                () => undefined,
                (error: unknown) => error,
              );
            const runningA = ended(a.prompt(hang ?? []));
            const runningB = ended(b.prompt(hang ?? []));
            await settle();
            await h.crash?.();
            expect(await runningA).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
            expect(await runningB).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
            await a.close();
            await b.close();
            expect(await h.processesAlive()).toBe(0);
          },
        );
      });

      promptTest('a permission request of the client is refused by the policy', async (ctx) => {
        const h = harness();
        if (h.permission === undefined) ctx.skip();
        const session = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        const outcome = await session.prompt(h.permission?.prompt ?? []);
        expect(['end_turn', 'cancelled', 'refusal']).toContain(outcome.stopReason);
        expect(await h.permission?.granted()).toBe(false);
        await session.close();
        expect(await h.processesAlive()).toBe(0);
      });

      promptTest('cancel ends the turn, and the whole process tree with it', async (ctx) => {
        const h = harness();
        if (h.prompts.hang === undefined) ctx.skip();
        const session = await h.adapter.openSession(h.profile, h.policy, h.cwd, h.via);
        const running = session.prompt(h.prompts.hang ?? []);
        await settle();
        await session.cancel();
        await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
        expect(await h.processesAlive()).toBe(0);
      });
    },
  );
}
