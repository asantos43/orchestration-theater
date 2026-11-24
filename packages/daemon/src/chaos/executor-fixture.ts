// SPDX-License-Identifier: MPL-2.0
// Shared by the chaos tests of the Executor (Phase 11, P4). Test only: excluded from the build.
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROLE_POLICY_FIELDS,
  type ClientAdapter,
  type Clock,
  type Enforcement,
  type EventEnvelope,
  type Profile,
  type SecretVault,
} from '@otheater/core';
import type { ClientFactoryParts } from '../clients.js';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type DaemonConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import type { AttemptOutcome, AttemptSpec } from '../execution/attempt-runner.js';
import { BASE_POLICY, FAKE_AGENT_CLI } from '../execution/escape-fixture.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { aliveEntries, PID_DIR_NAME, takeCensus, type Census, type CensusEntry } from './census.js';
import {
  assertInvariants,
  checkI1,
  checkI3,
  checkI5,
  checkI7,
  type InvariantResult,
} from './invariants.js';

/** The fake clock of the test: a `Clock` that moves only when told, and says what waits on it. */
export interface MovableClock extends Clock {
  advance(ms: number): Promise<void>;
  readonly pendingSleeps: number;
}

/**
 * What the test files take from `@otheater/core/testing` (only `*.test.ts` files may import it, rule
 * `testing-only-from-tests`) and hand to this fixture, once, with `installExecutorFakes`.
 */
export interface ExecutorFakes {
  readonly clock: () => MovableClock;
  readonly vault: () => SecretVault;
  /** The fake client adapter that runs the fake agent CLI over real ACP stdio. */
  readonly client: (options: {
    readonly parts: ClientFactoryParts;
    readonly unenforced: DaemonConfig['security']['unenforced'];
    readonly enforcement: Enforcement;
    readonly command: { readonly cmd: string; readonly args: readonly string[] };
    readonly env: Readonly<Record<string, string>>;
  }) => ClientAdapter;
}

let installed: ExecutorFakes | undefined;

export function installExecutorFakes(fakes: ExecutorFakes): void {
  installed = fakes;
}

/** A client like the real ones as to the OS fields (see `escape-fixture.ts`). */
const ENFORCEMENT = Object.fromEntries(
  ROLE_POLICY_FIELDS.map((field) => [
    field,
    field === 'writeScope' || field === 'network' ? [] : ['client'],
  ]),
) as unknown as Enforcement;

export interface ExecutorRigOptions {
  /** Extra YAML after the base config (`resume:`, `limits:` ...). */
  readonly config?: string;
  /**
   * The default script of the fake agent (`FAKE_AGENT_SCRIPT`): `name` or `name {json}`. A resume
   * sends the prompt of `resume.continue_prompt`, which names no script, so a failure that has to
   * come back on every resume is set here, not in the prompt.
   */
  readonly script?: string;
  /** More variables for the fake agent. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecutorRig {
  readonly daemon: DaemonHandle;
  readonly clock: MovableClock;
  readonly repo: string;
  readonly profile: Profile;
  /** The folder unique to this run: the census finds every process whose command, cwd or env holds it. */
  readonly runDir: string;
  readonly dataDir: string;
  /** `FAKE_AGENT_STATE_DIR`: `<state dir>/pids/*.pid` are the pid files of the census. */
  readonly stateDir: string;
  readonly storePath: string;
  /** Every event of the log. */
  events(): Promise<readonly EventEnvelope[]>;
  /** Waits until the log has an event the predicate accepts (returns it). The gate of a chaos test. */
  waitForEvent(
    description: string,
    predicate: (event: EventEnvelope) => boolean,
  ): Promise<EventEnvelope>;
  /** Waits until a file exists and returns its text. */
  waitForFile(path: string): Promise<string>;
  /** Starts an attempt; the promise is the outcome. Nothing awaits it for the caller. */
  attempt(prompt: string, overrides?: Partial<AttemptSpec>): Promise<AttemptOutcome>;
  /** The processes of the run, from the three sources of the census. */
  census(): Census;
}

const WAIT_CAP_MS = 120_000;
const POLL_MS = 5;

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, POLL_MS);
  });

/** Ends, by pid, what the census still finds alive: a test that failed must not leave an orphan. */
function reap(entries: readonly CensusEntry[]): void {
  for (const pid of new Set(entries.map((entry) => entry.pid))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * A daemon with the fake agent as a client, over the real ACP stdio and the real launcher. When the
 * body returns, the run goes through the invariants that fit a run without a daemon kill: I3 (no
 * process of the census alive), then, with the daemon stopped, I1 (the databases), I5 (no effect
 * left open) and I7 (no temporary file). A failure of any of them fails the test.
 */
export async function withExecutorRig(
  options: ExecutorRigOptions,
  body: (rig: ExecutorRig) => Promise<void>,
): Promise<void> {
  if (installed === undefined) throw new Error('call installExecutorFakes() first');
  const fakes = installed;
  const tmp = await makeTempDataDir();
  const runDir = await realpath(tmp.dir);
  const stateDir = join(runDir, 'state');
  await mkdir(join(stateDir, PID_DIR_NAME), { recursive: true });
  const launcher = defaultLauncher();
  if (launcher === undefined) throw new Error('this platform has no process launcher');
  const config = parseConfig(
    `backup:\n  when: manual\nsecurity:\n  unenforced: warn\nsandbox:\n  mode: off\n${options.config ?? ''}`,
  );
  const profileDir = join(runDir, 'profiles', 'fake', 'one');
  await mkdir(profileDir, { recursive: true });
  const profile: Profile = { client: 'fake', profile: 'one', id: 'fake/one', dir: profileDir };
  const clock = fakes.clock();
  const env: Record<string, string> = {
    FAKE_AGENT_STATE_DIR: stateDir,
    ...(options.script === undefined ? {} : { FAKE_AGENT_SCRIPT: options.script }),
    ...options.env,
  };
  const daemon = await startDaemon({
    dataDir: runDir,
    config,
    overrides: { clock, vault: fakes.vault(), launcher },
    clients: (parts) => [
      ...productionClients(config)(parts),
      fakes.client({
        parts,
        unenforced: config.security.unenforced,
        enforcement: ENFORCEMENT,
        command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
        env,
      }),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  const { repo, dispose } = await makeRepo();
  const storePath = join(runDir, 'store.sqlite');
  const census = (): Census => takeCensus({ runDir, stateDir, storePath });
  const events = (): Promise<readonly EventEnvelope[]> =>
    daemon.store.events.readFrom(0, 1_000_000);
  let counter = 0;
  const rig: ExecutorRig = {
    daemon,
    clock,
    repo,
    profile,
    runDir,
    dataDir: runDir,
    stateDir,
    storePath,
    events,
    waitForEvent: async (description, predicate) => {
      const started = Date.now();
      for (;;) {
        const found = (await events()).find(predicate);
        if (found !== undefined) return found;
        if (Date.now() - started > WAIT_CAP_MS) {
          throw new Error(`gave up waiting for the event: ${description}`);
        }
        await tick();
      }
    },
    waitForFile: async (path) => {
      const started = Date.now();
      while (!existsSync(path)) {
        if (Date.now() - started > WAIT_CAP_MS) throw new Error(`gave up waiting for ${path}`);
        await tick();
      }
      // The writer made it in one call; a read that sees it empty tries again.
      for (;;) {
        const text = await readFile(path, 'utf8');
        if (text !== '') return text;
        await tick();
      }
    },
    attempt: (prompt, overrides = {}) => {
      counter += 1;
      const runner = daemon.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution service');
      return runner.run({
        playId: 'play-chaos',
        demandId: `demand-${String(counter)}`,
        attempt: 1,
        repo,
        base: 'main',
        profile,
        executor: { model: 'fake-model' },
        policy: BASE_POLICY,
        prompt,
        role: 'actor',
        ...overrides,
      });
    },
    census,
  };
  const results: InvariantResult[] = [];
  try {
    await body(rig);
    // Nothing of the run may be alive once the body is done (I3), before the cleanup below ends it.
    results.push(checkI3(census()));
  } finally {
    // A failed test must not leave a process: whatever the census finds alive goes by pid.
    reap(aliveEntries(census()));
    await dispose();
    await daemon.stop();
  }
  // The rest is read from the files of a daemon that stopped: no lock or journal of a live one.
  results.push(checkI1({ dataDir: runDir }), checkI5({ storePath }), checkI7({ root: runDir }));
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  await tmp.dispose();
  assertInvariants(results);
}

/** The events of an attempt of a type, in order. */
export function eventsOf(
  events: readonly EventEnvelope[],
  type: string,
  attemptId?: string,
): EventEnvelope[] {
  return events.filter(
    (event) => event.type === type && (attemptId === undefined || event.attemptId === attemptId),
  );
}

/** The `#script:` directive that plays one script of the fake agent in a prompt. */
export function scriptPrompt(name: string, args: Record<string, unknown> = {}): string {
  return `#script:${name} ${JSON.stringify(args)}\nchaos`;
}
