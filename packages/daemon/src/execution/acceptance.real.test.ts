// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionDenied } from '@otheater/core';
import type {
  EventEnvelope,
  LaunchedProcess,
  LaunchOptions,
  Profile,
  ProcessLauncher,
  RolePolicy,
} from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { pathFinder, selectClients, type ClientSelection } from '../clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type ClientId } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir, TEST_PROFILE } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptOutcome, AttemptSpec } from './attempt-runner.js';

/**
 * Acceptance of step P9b (architecture 5.2, 5.16, 5.21; N57), with the REAL clients. Nothing here
 * runs by default: a plain `pnpm test` skips the whole file, so no client is started and no quota
 * is spent.
 *
 * - `OT_TEST_REAL_CLIENTS=1`: the daemon starts each enabled client (the ones its default factory
 *   finds in PATH), does `initialize` and `session/new` and ends it, in an EMPTY temporary
 *   profile. No prompt goes out.
 * - `OT_TEST_REAL_PROMPTS=1` (plus a logged-in profile and a model per client): the whole
 *   criterion of step 8, with one real Executor per enabled client plus simulated ones (the fake
 *   agent over the real ACP transport: `sim-edit` writes with `write-file`, which asks for no
 *   permission, and `sim-refused` uses `edit-file`, which asks and is refused by `onAsk: reject`;
 *   `simulated-acp.test.ts` runs these two without real clients), each in its own worktree: the
 *   stream as events, a timeout, the WIP commit and no process left.
 *
 * A logged-in profile is pointed at, never copied, and is used as is and never deleted (the
 * pattern of `OT_TEST_OPENCODE_PROFILE_DIR` in `adapter-client-opencode`):
 * - `OT_TEST_CLAUDE_PROFILE_DIR`, `OT_TEST_CODEX_PROFILE_DIR`, `OT_TEST_OPENCODE_PROFILE_DIR`;
 * - `OT_TEST_CLAUDE_MODEL`, `OT_TEST_CODEX_MODEL`, `OT_TEST_OPENCODE_MODEL`: the model id the
 *   client's catalog lists (the test does not guess one);
 * - `OT_TEST_CLAUDE_MODE`, `OT_TEST_CODEX_MODE`, `OT_TEST_OPENCODE_MODE` (optional): the mode id
 *   that lets the client write inside the worktree without asking.
 * A client with no profile or no model is left out of the prompts part, and the log says so.
 *
 * [proposta] The real clients run with `security.unenforced: warn`: with no sandbox yet (Phase 4)
 * the policy's `writeScope` and `network` have no layer, and the architecture's default would
 * refuse the session. The prompts are harmless (a read-only question, and files written inside a
 * temporary worktree). [proposta] Codex runs one process per session
 * (`clients.codex.process_model: process-per-session`) and OpenCode too
 * (`pool.opencode.process_model: per_session`), which works with or without `multi-session` in
 * the ACP transport. Nothing here reads or prints a credential.
 * [N] Not run in this step (N57): written to be run by the owner.
 */

const flags = realClientFlags();
const supported = process.platform !== 'win32';
const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const MINUTE = 60_000;

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
clients:
  codex:
    process_model: process-per-session
pool:
  opencode:
    process_model: per_session
resume:
  checkpoint_edit_batch: 1
  checkpoint_every: 5m
`);

const PROFILE_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_PROFILE_DIR',
  codex: 'OT_TEST_CODEX_PROFILE_DIR',
  opencode: 'OT_TEST_OPENCODE_PROFILE_DIR',
};
const MODEL_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_MODEL',
  codex: 'OT_TEST_CODEX_MODEL',
  opencode: 'OT_TEST_OPENCODE_MODEL',
};
const MODE_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_MODE',
  codex: 'OT_TEST_CODEX_MODE',
  opencode: 'OT_TEST_OPENCODE_MODE',
};

/**
 * What `session/new` does in an EMPTY profile, per client. Claude Code and OpenCode open the
 * session with no login (the first prompt is what asks for one). Codex does not: `codex-acp` 2.6
 * answers `session/new` with JSON-RPC -32000 "Authentication required" and does not start a login
 * by itself (measured in Phase 0, `spikes/acp-codex/README.md`, item 9), so the pool must refuse
 * with `PermissionDenied` (kind `auth_required`) and leave no process behind.
 */
const EMPTY_PROFILE_OUTCOME: Readonly<Record<ClientId, 'session' | 'auth_required'>> = {
  'claude-code': 'session',
  codex: 'auth_required',
  opencode: 'session',
};

const READ_ONLY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};
const WRITING: RolePolicy = { ...READ_ONLY, nativeTools: ['read', 'search', 'edit', 'write'] };

afterAll(disposeTestGitIsolation);

/** The clients the daemon's own search finds in PATH (no process is started to ask). */
const found: readonly ClientSelection[] =
  flags.clients && supported
    ? selectClients(CONFIG, DEFAULT_CLIENT_EXECUTABLES, pathFinder(process.env)).filter(
        (selection) => selection.enabled,
      )
    : [];

function value(name: string): string | undefined {
  const text = process.env[name];
  return text === undefined || text === '' ? undefined : text;
}

/** A launcher that remembers the pid of every process it starts, to look for orphans after. */
function recording(inner: ProcessLauncher): { launcher: ProcessLauncher; pids: number[] } {
  const pids: number[] = [];
  const launcher: ProcessLauncher = {
    id: inner.id,
    implements: inner.implements,
    capabilities: () => inner.capabilities(),
    launch: async (options: LaunchOptions): Promise<LaunchedProcess> => {
      const process = await inner.launch(options);
      pids.push(process.pid);
      return process;
    },
  };
  return { launcher, pids };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Rig {
  readonly daemon: DaemonHandle;
  readonly clock: FakeClock;
  readonly dataDir: string;
  readonly pids: readonly number[];
  readonly root: string;
  /** Profile of a client: the one the owner pointed at (used as is) or an empty temporary one. */
  profile(client: ClientId): Profile;
  dispose(): Promise<void>;
}

async function openRig(simulated: boolean): Promise<Rig> {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
  const tmp = await makeTempDataDir();
  const root = await mkdtemp(join(tmpdir(), 'otheater-real-'));
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const { launcher, pids } = recording(real);
  const clock = new FakeClock();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: CONFIG,
    overrides: { clock, vault: new InMemorySecretVault(), launcher },
    clients: (parts) => [
      ...productionClients(CONFIG)(parts),
      ...(simulated
        ? [
            new FakeClientAdapter({
              launcher: parts.launcher,
              baseEnv: {},
              adapterVersion: '1.0.0',
              command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
            }),
          ]
        : []),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  return {
    daemon,
    clock,
    dataDir: tmp.dir,
    pids,
    root,
    profile: (client) => {
      const dir = value(PROFILE_ENV[client]) ?? join(root, 'profiles', client);
      return { client, profile: 'real', id: `${client}/real`, dir };
    },
    dispose: async () => {
      await daemon.stop();
      await tmp.dispose();
      // Only what this test created: a profile the owner pointed at is outside `root`.
      await rm(root, { recursive: true, force: true });
    },
  };
}

function typesOf(events: readonly EventEnvelope[], attemptId: string): readonly string[] {
  return events.filter((event) => event.attemptId === attemptId).map((event) => event.type);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  limitMs: number,
): Promise<void> {
  const limit = Date.now() + limitMs;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!flags.clients || !supported)(
  'real clients: start, initialize and session/new (OT_TEST_REAL_CLIENTS=1)',
  () => {
    it('finds at least one client in PATH', () => {
      expect(
        found.map((selection) => selection.id),
        'none of claude-agent-acp, codex-acp or opencode is in PATH (or clients.<id>.enabled is off)',
      ).not.toHaveLength(0);
    });

    it.each(found.map((selection) => [selection.id, selection] as const))(
      '%s: starts, opens a session in an empty profile (or is refused with auth_required) and leaves no process',
      async (id) => {
        const rig = await openRig(false);
        try {
          const execution = rig.daemon.execution;
          if (execution === undefined) throw new Error('the daemon has no execution');
          // An empty profile of this test, never the owner's: nothing is logged in here.
          const empty: Profile = {
            client: id,
            profile: 'empty',
            id: `${id}/empty`,
            dir: join(rig.root, 'empty', id),
          };
          await mkdir(empty.dir, { recursive: true });
          const cwd = join(rig.root, 'work', id);
          await mkdir(cwd, { recursive: true });
          const request = { client: id, profile: empty, policy: READ_ONLY, cwd };
          if (EMPTY_PROFILE_OUTCOME[id] === 'auth_required') {
            // The refusal is a `PermissionDenied`; the kind is in the `NormalizedError` it carries
            // as `cause` (`typedErrorOf`, architecture 5.2). The message text is not asserted.
            const refusal = await execution.pool.acquire(request).then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(refusal, 'acquire should have been refused').toBeInstanceOf(PermissionDenied);
            expect((refusal as PermissionDenied).cause).toMatchObject({ kind: 'auth_required' });
            // The refused open gave its slot back and the pool keeps nothing.
            expect(execution.pool.stats()).toMatchObject({ processes: 0, sessions: 0, queued: 0 });
          } else {
            const lease = await execution.pool.acquire(request);
            expect(lease.session.sessionId.length).toBeGreaterThan(0);
            expect(alive(lease.pid)).toBe(true);
            await lease.release();
            if (id === 'opencode') {
              // OpenCode lists its models through the same process model and the profile directory.
              const models = await execution.pool.adapterOf(id).models.list({
                client: id,
                profile: empty.profile,
              });
              expect(Array.isArray(models)).toBe(true);
            }
          }
        } finally {
          await rig.dispose();
        }
        // Whatever the test started (a refused Codex included) is gone: nothing left on the pids
        // it saw. It is checked here, after the daemon stopped, in both outcomes.
        expect(rig.pids.length).toBeGreaterThan(0);
        expect(rig.pids.filter(alive)).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!flags.clients || !flags.prompts || !supported)(
  'real clients: the whole criterion with prompts (OT_TEST_REAL_PROMPTS=1)',
  () => {
    const ready = found.filter(
      (selection) =>
        value(PROFILE_ENV[selection.id]) !== undefined &&
        value(MODEL_ENV[selection.id]) !== undefined,
    );

    it(
      'runs one Executor per enabled client and one simulated at once, each in its own worktree',
      async () => {
        const skipped = found.filter((selection) => !ready.includes(selection));
        for (const selection of skipped) {
          console.warn(
            `[${selection.id}] left out: set ${PROFILE_ENV[selection.id]} and ${MODEL_ENV[selection.id]}`,
          );
        }
        const rig = await openRig(true);
        const { repo, dispose: disposeRepo } = await makeRepo();
        try {
          const runner = rig.daemon.execution?.runner;
          if (runner === undefined) throw new Error('the daemon has no execution');
          const worktrees = dataPaths(rig.dataDir).worktrees;
          const spec = (
            profile: Profile,
            demandId: string,
            prompt: string,
            options: Partial<AttemptSpec> = {},
          ): AttemptSpec => ({
            playId: 'play-real',
            demandId,
            attempt: 1,
            repo,
            base: 'main',
            profile,
            executor: { model: 'fake-model' },
            policy: WRITING,
            prompt,
            ...options,
          });
          const simulated = (demandId: string, prompt: string, timeoutMs?: number): AttemptSpec =>
            spec(TEST_PROFILE, demandId, prompt, timeoutMs === undefined ? {} : { timeoutMs });
          const realSpec = (
            selection: ClientSelection,
            demandId: string,
            prompt: string,
            options: Partial<AttemptSpec> = {},
          ): AttemptSpec => {
            const mode = value(MODE_ENV[selection.id]);
            return spec(rig.profile(selection.id), demandId, prompt, {
              executor: {
                model: value(MODEL_ENV[selection.id]) ?? '',
                ...(mode === undefined ? {} : { mode }),
              },
              ...options,
            });
          };
          const worktreeOf = (demandId: string): string =>
            join(worktrees, 'play-real', `${demandId}-1`);
          const hanging = (attemptId: string): Promise<void> =>
            waitFor(
              async () =>
                (await rig.daemon.store.events.readFrom(0, 100_000)).some(
                  (event) =>
                    event.attemptId === attemptId &&
                    JSON.stringify(event.payload).includes('hanging until session/cancel'),
                ),
              `${attemptId} to hang`,
              60_000,
            );

          // Everything starts together: each attempt has its own worktree and branch.
          const streams = ready.map((selection) => ({
            selection,
            demand: `stream-${selection.id}`,
            done: runner.run(
              realSpec(
                selection,
                `stream-${selection.id}`,
                'Reply with exactly the word pong and do not use any tool.',
                { policy: READ_ONLY },
              ),
            ),
          }));
          const drafts = ready.map((selection) => ({
            selection,
            demand: `draft-${selection.id}`,
            done: runner.run(
              realSpec(
                selection,
                `draft-${selection.id}`,
                [
                  'Use your file-writing tool to create the file draft.txt with the single line draft.',
                  'Then, without stopping, create the files f1.txt to f300.txt, one tool call each,',
                  'with the number of the file as its content. Do not answer before you finish.',
                ].join(' '),
                { timeoutMs: TIMEOUT_MS },
              ),
            ),
          }));
          // `write-file` writes with no permission request (a client whose mode already allows the
          // edit); `edit-file` asks, and the policy rejects every ask (`onAsk: 'reject'`, 5.8).
          const edited = runner.run(
            simulated(
              'sim-edit',
              '#script:write-file {"path":"sim.txt","content":"simulated\\n"}\nedit',
            ),
          );
          const refused = runner.run(
            simulated(
              'sim-refused',
              '#script:edit-file {"path":"sim.txt","content":"simulated\\n"}\nedit',
            ),
          );
          const hung = runner.run(simulated('sim-hang', '#script:hang', TIMEOUT_MS));
          await hanging('play-real/sim-hang/1');
          for (const { demand } of drafts) {
            await waitFor(
              () => exists(join(worktreeOf(demand), 'draft.txt')),
              `${demand} to write draft.txt`,
              10 * MINUTE,
            );
          }

          // 1. The stream is in the log: opened, updates, closed.
          const outcomes: AttemptOutcome[] = [];
          for (const { selection, demand, done } of streams) {
            const outcome = await done;
            outcomes.push(outcome);
            expect(outcome, selection.id).toMatchObject({ state: 'completed' });
            const types = typesOf(
              await rig.daemon.store.events.readFrom(0, 100_000),
              `play-real/${demand}/1`,
            );
            expect(types[0]).toBe('session.opened');
            expect(types.filter((type) => type === 'session.update').length).toBeGreaterThan(0);
            expect(types.at(-1)).toBe('session.closed');
          }
          const simulatedEdit = await edited;
          outcomes.push(simulatedEdit);
          expect(simulatedEdit).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
          const simulatedTypes = typesOf(
            await rig.daemon.store.events.readFrom(0, 100_000),
            simulatedEdit.attemptId,
          );
          expect(simulatedTypes).toContain('attempt.checkpoint');
          expect(await testGit(simulatedEdit.worktree, 'show', 'HEAD:sim.txt')).toBe('simulated');
          // The refused edit: the ask was rejected over the real ACP transport, so the tool call
          // failed, nothing was written and nothing was checkpointed.
          const refusedEdit = await refused;
          outcomes.push(refusedEdit);
          expect(refusedEdit).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
          const refusedEvents = (await rig.daemon.store.events.readFrom(0, 100_000)).filter(
            (event) => event.attemptId === refusedEdit.attemptId,
          );
          expect(refusedEvents.map((event) => event.type)).not.toContain('attempt.checkpoint');
          expect(
            refusedEvents.some(
              (event) =>
                event.type === 'session.update' &&
                JSON.stringify(event.payload).includes('"kind":"tool_call_update"') &&
                JSON.stringify(event.payload).includes('"status":"failed"'),
            ),
          ).toBe(true);
          expect(await exists(join(refusedEdit.worktree, 'sim.txt'))).toBe(false);

          // 2. The timeout cuts what is still running: WIP commit, cancel, kill.
          await rig.clock.advance(TIMEOUT_MS);
          const cut = await hung;
          outcomes.push(cut);
          expect(cut).toMatchObject({ state: 'timed_out', cause: 'timeout' });
          for (const { selection, done } of drafts) {
            const outcome = await done;
            outcomes.push(outcome);
            expect(outcome, selection.id).toMatchObject({ state: 'timed_out', cause: 'timeout' });
            expect(await testGit(outcome.worktree, 'show', 'HEAD:draft.txt')).toContain('draft');
          }

          // 3. Different worktrees, and no process left once the daemon stops.
          expect(new Set(outcomes.map((outcome) => outcome.worktree)).size).toBe(outcomes.length);
          await rig.daemon.stop();
          expect(rig.daemon.execution?.pool.stats().processes).toBe(0);
          expect(rig.pids.length).toBeGreaterThan(0);
          expect(rig.pids.filter(alive)).toEqual([]);
        } finally {
          await disposeRepo();
          await rig.dispose();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
