// SPDX-License-Identifier: MPL-2.0
// Shared by the end-to-end tests of the play only (excluded from the build of the package).
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type {
  Adapter,
  AdapterImplements,
  BranchTarget,
  ClientAdapter,
  Clock,
  CodeHost,
  EventEnvelope,
  FindPullRequestOptions,
  MergeBranchOptions,
  MergeBranchResult,
  OpenPullRequestOptions,
  PlayRecord,
  ProcessLauncher,
  PullRequest,
  SecretVault,
  TelemetryStore,
} from '@otheater/core';
import { testGit } from '@otheater/sdk';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger, type Logger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig, type WorkspaceRig } from '../workspace/workspace-fixture.js';
import type { ProducerChannel } from './channel.js';

/** The compiled fake agent: `pnpm build` comes first. */
export const FAKE_AGENT_CLI = fileURLToPath(
  new URL('../../../fake-agent/dist/cli.js', import.meta.url),
);

export function assertFakeAgentBuilt(): void {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
}

/**
 * What the tests take from `@otheater/core/testing` (only `*.test.ts` files may import it, rule
 * `testing-only-from-tests`) and hand to the fixture.
 */
export interface FakeCodeHostLike extends CodeHost {
  adoptLocal(repo: string, branch: string, sha: string): void;
  seedRemote(repo: string, branch: string): string;
  pullRequests(): readonly PullRequest[];
}

export interface PlayFakes {
  readonly codeHost: FakeCodeHostLike;
  readonly clock: Clock;
  readonly vault: SecretVault;
  /**
   * The fake client adapter that runs the command it is given, with `env` in its processes. A test
   * that needs more than one client (one that accepts images, say) returns a list; each one
   * needs its own id.
   */
  readonly client: (
    launcher: ProcessLauncher,
    command: { readonly cmd: string; readonly args: readonly string[] },
    env: Readonly<Record<string, string>>,
  ) => ClientAdapter | readonly ClientAdapter[];
}

/**
 * A code host in memory whose pushes are the real heads of the repository: the fake knows nothing
 * of git, so each push first tells it where the branch really is.
 */
export class RealHeadCodeHost implements CodeHost {
  readonly id: string;
  readonly implements: AdapterImplements;
  readonly #fake: FakeCodeHostLike;

  constructor(fake: FakeCodeHostLike) {
    this.#fake = fake;
    this.id = (fake as Adapter).id;
    this.implements = (fake as Adapter).implements;
  }

  async pushRef(target: BranchTarget): Promise<string> {
    const head = await testGit(target.repo, 'rev-parse', `refs/heads/${target.branch}`);
    this.#fake.adoptLocal(target.repo, target.branch, head.trim());
    return this.#fake.pushRef(target);
  }

  remoteRef(target: BranchTarget): Promise<string | undefined> {
    return this.#fake.remoteRef(target);
  }

  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    return this.#fake.openPullRequest(opts);
  }

  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    return this.#fake.findPullRequest(opts);
  }

  mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    return this.#fake.mergeBranch(opts);
  }

  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    return this.#fake.isBranchMerged(opts);
  }
}

export interface PlayHarness {
  readonly daemon: DaemonHandle;
  readonly producer: ProducerChannel;
  readonly codeHost: FakeCodeHostLike;
  readonly rig: WorkspaceRig;
  readonly dataDir: string;
  /** Opens the chat of the repository and returns the scenario id. */
  openChat(): Promise<string>;
  /** Opens a generic chat (type `chat`, no repository) and returns the scenario id. */
  openGenericChat(name?: string): Promise<string>;
  /** The plays of the scenario, newest last. */
  plays(scenarioId: string): Promise<readonly PlayRecord[]>;
  /** Every event of the play, in order. */
  eventsOf(playId: string): Promise<readonly EventEnvelope[]>;
  /** The states the play went through, from the `play.transitioned` events. */
  pathOf(playId: string): Promise<readonly string[]>;
}

/** Polls `read` until it returns something, or fails after `timeoutMs` of real time. */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

export interface PlayHarnessOptions {
  /** Extra YAML under `limits:` (two spaces of indent each line). */
  readonly limits?: string;
  /** Extra top-level YAML. */
  readonly extra?: string;
  /**
   * `project.conventions`. The fixture detects without asking (`detect`), so the question of the
   * confirmation of an imported repository does not take the place of the one a test waits for.
   */
  readonly conventions?: 'ask' | 'detect' | 'off';
  /** The telemetry store the daemon runs with (P4): the test reads the spans from it. */
  readonly telemetry?: TelemetryStore;
  /** The logger of the daemon (default: silent): a test that checks what the daemon logs hands in its own. */
  readonly logger?: Logger;
  /**
   * `security.attachment_roots.mode`. The fixture says `any` (the tests attach files from temporary
   * folders); the test of the roots itself says `list`.
   */
  readonly attachmentRoots?: 'any' | 'list';
}

/**
 * The daemon with the fake agent as every role (`role-play`), the fake code host and a real
 * repository with a bare `origin`, all in temporary folders. The clock is frozen, so no timer of
 * the daemon fires: the play moves only by what the roles do.
 */
export async function withPlayDaemon(
  fakes: PlayFakes,
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  assertFakeAgentBuilt();
  const tmp = await makeTempDataDir();
  const stateDir = await mkdtemp(join(tmpdir(), 'otheater-role-play-'));
  const launcher = defaultLauncher();
  if (launcher === undefined) throw new Error('this platform has no process launcher');
  const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
  # The tests attach files from temporary folders; the roots have their own tests (api/security-review.test.ts).
  attachment_roots:
    mode: ${options.attachmentRoots ?? 'any'}
shell:
  http_get:
    # The tests serve http_get from 127.0.0.1; the refusal has its own tests (tools/http-get.test.ts).
    block_private: off
limits:
  submit_retries: 1
${options.limits ?? ''}
project:
  conventions: ${options.conventions ?? 'detect'}
orchestration:
  executor:
    client: fake
    profile: one
    model: fake-model
${options.extra ?? ''}
`);
  const { codeHost } = fakes;
  const realHead = new RealHeadCodeHost(codeHost);
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config,
    overrides: {
      clock: fakes.clock,
      vault: fakes.vault,
      launcher,
      codeHost: realHead,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    clients: (parts) => [
      ...productionClients(config)(parts),
      ...[
        fakes.client(
          parts.launcher,
          { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
          { FAKE_AGENT_SCRIPT: 'role-play', FAKE_AGENT_STATE_DIR: stateDir },
        ),
      ].flat(),
    ],
    logger: options.logger ?? createSilentLogger(),
    version: '0.0.0-test',
  });
  const rig = await makeWorkspaceRig({ store: daemon.store, codeHost: realHead });
  codeHost.seedRemote(rig.repo, 'main');
  const { producer } = daemon;
  if (producer === undefined) throw new Error('the daemon has no Producer channel');
  try {
    await body({
      daemon,
      producer,
      codeHost,
      rig,
      dataDir: tmp.dir,
      openChat: async () => (await producer.openChat({ repo: rig.repo })).scenarioId,
      openGenericChat: async (name) =>
        (await producer.openChat({ type: 'chat', ...(name === undefined ? {} : { name }) }))
          .scenarioId,
      plays: (scenarioId) => daemon.store.plays.list({ scenarioId }),
      eventsOf: async (playId) =>
        (await daemon.store.events.readFrom(0, 100_000)).filter((event) => event.playId === playId),
      pathOf: async (playId) => {
        const events = (await daemon.store.events.readFrom(0, 100_000)).filter(
          (event) => event.playId === playId && event.type === 'play.transitioned',
        );
        return events.map((event) => (event.payload as { to: string }).to);
      },
    });
  } finally {
    await daemon.stop();
    await rig.dispose();
    await rm(stateDir, { recursive: true, force: true });
    await tmp.dispose();
  }
}
