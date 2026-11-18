// SPDX-License-Identifier: MPL-2.0
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  LaunchedProcess,
  LaunchOptions,
  Profile,
  ProcessLauncher,
  ProfileRef,
  RolePolicy,
} from '@otheater/core';
import { InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { SystemClock } from '@otheater/adapter-clock-system';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { pathFinder, selectClients, type ClientSelection } from '../clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createLogger, createSilentLogger } from '../logger.js';
import { Writable } from 'node:stream';
import { dataPaths, profileDirOf } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import { MiniMaxProbeError, MiniMaxQuotaProbe } from './minimax-probe.js';
import { QuotaService, type ProfileTarget } from './service.js';
import { quotaSettingsOf } from './settings.js';
import type { QuotaStatus } from './state.js';

/**
 * The `quota` level of the real acceptance (P23, architecture 5.6 and the criterion of Phase 5):
 * it reads the REAL quota of each client the owner pointed at, through the probe the daemon itself
 * uses, and checks that every reading becomes a state the daemon understands. It never provokes
 * an exhaustion: the prompt is one trivial turn, and a client with no turn needed (Codex) gets
 * none. Nothing here runs by default: a plain `pnpm test` skips the whole file.
 *
 * - `OT_TEST_REAL_QUOTA=1` turns it on (`tools/acceptance/real-acceptance.sh --level quota`).
 * - Per client, a logged-in profile is POINTED at (a symlink inside a temporary data directory;
 *   never copied, never read, never deleted): `OT_TEST_CLAUDE_PROFILE_DIR`,
 *   `OT_TEST_CODEX_PROFILE_DIR`, `OT_TEST_OPENCODE_PROFILE_DIR`. A client without one is left out
 *   and the log says so.
 * - Codex: `account/rateLimits/read` of `codex app-server`, with no turn.
 * - Claude Code (needs `OT_TEST_CLAUDE_MODEL`; the owner uses Haiku): the statusline file of P6
 *   that a reply writes, so it takes one very short turn. The daemon installs its statusline
 *   command in the `settings.json` of the profile, as it does in any session (that is the one
 *   change this test lets the daemon make in a profile). `clients.claude-code.utilization_unit` is
 *   `auto` here, so the `rate_limit_event` of the turn also becomes a window (N123).
 * - OpenCode (needs `OT_TEST_OPENCODE_MODEL`): the local accounting of the daemon
 *   (`quota.opencode.mode: ledger`, `limit_tokens` from `OT_TEST_OPENCODE_LIMIT_TOKENS`, default
 *   1000000 [proposta]) over one very short turn.
 * - MiniMax: only if `OT_TEST_MINIMAX_KEY_ENV` holds the NAME of an environment variable that has
 *   the key. The test reads that variable and nothing else; the key goes only in the
 *   `Authorization` header of the Token Plan call, and never to the output, the log or an
 *   assertion message. `OT_TEST_MINIMAX_USAGE_COUNT_MEANS` (`remaining` or `used`, default
 *   `remaining`) is `quota.minimax.usage_count_means`.
 * - `OT_TEST_QUOTA_OUT`: where the JSON report goes (default a file in the temporary directory;
 *   the path is printed). It has no secret: client, windows, percentages (0..100, the unit of
 *   `QuotaWindow.usedPercent`), reset times, state and the reason of an `unknown`.
 *
 * [proposta] The assertion is that each reading becomes `ok`, `near_limit` or `unknown` with a
 * reason; `exhausted` is accepted only when a window really reads 100% (the account is out of
 * quota on its own, which the test did not cause). [N] Not run by the agent that wrote it: the
 * owner runs it (N122).
 */

const quotaFlag = process.env.OT_TEST_REAL_QUOTA === '1';
const supported = process.platform !== 'win32';
const enabled = quotaFlag && supported;

const TEST_TIMEOUT_MS = 8 * 60_000;
const TURN_TIMEOUT_MS = 4 * 60_000;
const SETTLE_MS = 20_000;
const PROMPT = 'Reply with exactly the word pong and do not use any tool.';

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

/** What each client needs for its reading, to say it in the report. */
const SOURCE: Readonly<Record<ClientId, string>> = {
  'claude-code': 'statusline file (P6) after one short turn, plus the rate_limit_event of the turn',
  codex: 'app-server account/rateLimits/read (no turn)',
  opencode:
    'local ledger (quota.opencode.mode: ledger) after one short turn; the OpenCode usage_update carries context counters and a cost, not input/output tokens, so a subscription model leaves the ledger at 0% [V: 2026-11-18]',
};
const NEEDS_TURN: Readonly<Record<ClientId, boolean>> = {
  'claude-code': true,
  codex: false,
  opencode: true,
};

const READ_ONLY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/** One line of the JSON report. No secret goes in it. */
interface Entry {
  readonly client: string;
  readonly source: string;
  /** Present when the client was left out, with why. */
  readonly skipped?: string;
  readonly turn?: boolean;
  readonly state?: string;
  /** The service's own sentence for the state. */
  readonly reason?: string;
  /** When `unknown`: why the probe gave no reading (its own words, cut). */
  readonly unknownReason?: string | null;
  readonly unit?: string;
  readonly windows?: readonly {
    readonly window: string;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
    readonly source: string;
    readonly fresh: boolean;
  }[];
  readonly untilReset?: string | null;
  readonly observedAt?: string | null;
}

const entries: Entry[] = [];

afterAll(async () => {
  disposeTestGitIsolation();
  if (!enabled || entries.length === 0) return;
  const out =
    value('OT_TEST_QUOTA_OUT') ?? join(tmpdir(), `otheater-quota-${String(Date.now())}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
  );
  console.log(`[quota-real] report written to ${out}`);
});

function value(name: string): string | undefined {
  const text = process.env[name];
  return text === undefined || text === '' ? undefined : text;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A launcher that remembers each pid it starts, to look for orphans after. */
function recording(inner: ProcessLauncher): { launcher: ProcessLauncher; pids: number[] } {
  const pids: number[] = [];
  const launcher: ProcessLauncher = {
    id: inner.id,
    implements: inner.implements,
    capabilities: () => inner.capabilities(),
    launch: async (options: LaunchOptions): Promise<LaunchedProcess> => {
      const launched = await inner.launch(options);
      pids.push(launched.pid);
      return launched;
    },
  };
  return { launcher, pids };
}

/** The text of an error, with what only the machine knows (paths) taken out, and cut. */
function reasonOf(error: unknown, ...paths: readonly string[]): string {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof MiniMaxProbeError) text = `${error.reason}: ${text}`;
  for (const path of paths) text = text.split(path).join('<profile>');
  return text.slice(0, 300);
}

function toEntry(
  client: string,
  status: QuotaStatus,
  fields: Pick<Entry, 'source' | 'turn' | 'unknownReason' | 'unit'>,
): Entry {
  return {
    client,
    ...fields,
    state: status.state,
    reason: status.reason,
    untilReset: iso(status.untilReset),
    observedAt: iso(status.observedAt),
    windows: status.windows.map((window) => ({
      window: window.window,
      usedPercent: window.usedPercent,
      resetsAt: iso(window.resetsAt),
      source: window.source,
      fresh: window.fresh,
    })),
  };
}

/** The assertion of the level: a valid state, and a reason when it is `unknown`. */
function expectValid(entry: Entry): void {
  const label = `${entry.client}: ${entry.state ?? '(no state)'}`;
  expect(['ok', 'near_limit', 'unknown', 'exhausted'], label).toContain(entry.state);
  if (entry.state === 'unknown') {
    expect(entry.unknownReason ?? entry.reason, `${label} has no reason`).toBeTruthy();
  }
  if (entry.state === 'exhausted') {
    // Not provoked: only a window that really reads full explains it.
    expect(
      entry.windows?.some((window) => window.usedPercent >= 100),
      `${label} without a window at 100%`,
    ).toBe(true);
  }
  for (const window of entry.windows ?? []) {
    expect(window.usedPercent, `${label} ${window.window}`).toBeGreaterThanOrEqual(0);
    expect(window.usedPercent, `${label} ${window.window}`).toBeLessThanOrEqual(100);
  }
}

// `sandbox.mode: off` on purpose [V: 2026-11-18, runs 1 to 3]: the default sandbox (runtime) refuses
// a profile reached through a symlink (Claude: "Authentication required", cause `permission`) and
// blocks the OpenAI host (OpenCode: "403 host is not on the allow list", ends `stuck`). This test
// points at the owner's profile through a link and only reads quota, so it runs the clients
// without the sandbox; the sandbox has its own real level (`mcp`).
const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
sandbox:
  mode: off
clients:
  claude-code:
    utilization_unit: auto
  codex:
    process_model: process-per-session
pool:
  opencode:
    process_model: per_session
quota:
  opencode:
    mode: ledger
    window: 5h
    limit_tokens: ${value('OT_TEST_OPENCODE_LIMIT_TOKENS') ?? '1000000'}
`);

/** The clients the daemon's own search finds in PATH (no process is started to ask). */
const found: readonly ClientSelection[] = enabled
  ? selectClients(CONFIG, DEFAULT_CLIENT_EXECUTABLES, pathFinder(process.env)).filter(
      (selection) => selection.enabled,
    )
  : [];
const ready = found.filter((selection) => value(PROFILE_ENV[selection.id]) !== undefined);

async function until<T>(
  read: () => Promise<T>,
  done: (current: T) => boolean,
  limitMs: number,
): Promise<T> {
  const limit = Date.now() + limitMs;
  let current = await read();
  while (!done(current) && Date.now() < limit) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await read();
  }
  return current;
}

describe.skipIf(!enabled)('real quota: the reading of each client (OT_TEST_REAL_QUOTA=1)', () => {
  it('has no client with a profile to read: says so, never fails for it', () => {
    for (const selection of found) {
      if (value(PROFILE_ENV[selection.id]) !== undefined) continue;
      const skipped = `set ${PROFILE_ENV[selection.id]} to read it`;
      console.warn(`[${selection.id}] left out: ${skipped}`);
      entries.push({ client: selection.id, source: SOURCE[selection.id], skipped });
    }
    if (found.length === 0) console.warn('[quota-real] no client in PATH');
    expect(true).toBe(true);
  });

  it.each(ready.map((selection) => [selection.id] as const))(
    '%s: reads the real quota and the state is valid',
    async (id) => {
      const profileSource = value(PROFILE_ENV[id]);
      const model = value(MODEL_ENV[id]);
      if (profileSource === undefined) throw new Error('unreachable: filtered above');
      if (NEEDS_TURN[id] && model === undefined) {
        const skipped = `set ${MODEL_ENV[id]}: this client needs one short turn`;
        console.warn(`[${id}] left out: ${skipped}`);
        entries.push({ client: id, source: SOURCE[id], skipped });
        return;
      }
      const tmp = await makeTempDataDir();
      const real = defaultLauncher();
      if (real === undefined) throw new Error('this platform has no process launcher');
      const { launcher, pids } = recording(real);
      // The profile is the owner's logged-in one: a link inside the temporary data directory,
      // never a copy. Only the link is removed at the end.
      const ref: ProfileRef = { client: id, profile: 'real' };
      const link = profileDirOf(dataPaths(tmp.dir), ref);
      await mkdir(dirname(link), { recursive: true });
      await symlink(profileSource, link, 'dir');
      const profile: Profile = {
        client: id,
        profile: 'real',
        id: `${id}/real`,
        dir: link,
      };
      // The warnings of the daemon, kept to explain a turn that did not end well.
      const warnings: string[] = [];
      const daemonLog = createLogger({
        level: 'warn',
        destination: 'stderr',
        logFile: '',
        clock: new SystemClock(),
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            warnings.push(chunk.toString('utf8'));
            done();
          },
        }),
      });
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: CONFIG,
        // The clock is the real one: the probes stamp their readings with the wall clock.
        overrides: { vault: new InMemorySecretVault(), launcher },
        clients: productionClients(CONFIG),
        logger: daemonLog.logger,
        version: '0.0.0-test',
      });
      const target: ProfileTarget = ref;
      try {
        const read = async (): Promise<{ status: QuotaStatus; unknownReason: string | null }> => {
          const status = await daemon.quota.refresh(target);
          if (status.state !== 'unknown') return { status, unknownReason: null };
          // `refresh` swallows the probe's refusal; ask the probe again for its words.
          const probe = daemon.quota.probeOf(id);
          if (probe === undefined)
            return { status, unknownReason: 'the client has no quota probe' };
          try {
            await probe.read(ref);
            return { status, unknownReason: status.reason };
          } catch (error) {
            return { status, unknownReason: reasonOf(error, link, profileSource, tmp.dir) };
          }
        };
        if (NEEDS_TURN[id]) {
          const execution = daemon.execution;
          if (execution === undefined) throw new Error('the daemon has no execution');
          const { repo, dispose } = await makeRepo();
          try {
            const mode = value(MODE_ENV[id]);
            const outcome = await execution.runner.run({
              playId: 'quota-real',
              demandId: `quota-${id}`,
              attempt: 1,
              repo,
              base: 'main',
              profile,
              executor: { model: model ?? '', ...(mode === undefined ? {} : { mode }) },
              policy: READ_ONLY,
              prompt: PROMPT,
              timeoutMs: TURN_TIMEOUT_MS,
            });
            console.log(
              `[quota-real] ${id}: the turn ended ${outcome.state} (cause ${(outcome.cause ?? 'none').slice(0, 200)}, stop ${outcome.stopReason ?? 'none'})`,
            );
            if (outcome.state !== 'completed') {
              for (const line of warnings.slice(0, 20)) {
                console.log(
                  `[quota-real] ${id}: daemon log ${line.split(profileSource).join('<profile>').slice(0, 600).trim()}`,
                );
              }
              // What the turn did before it ended: the types and a cut of each payload (the
              // events carry no credential; the profile path is hidden).
              const events = await daemon.store.events.readFrom(0, 100_000);
              for (const event of events.filter((one) => one.attemptId === outcome.attemptId)) {
                const text = JSON.stringify(event.payload)
                  .split(profileSource)
                  .join('<profile>')
                  .slice(0, 400);
                console.log(`[quota-real] ${id}: event ${event.type} ${text}`);
              }
            }
          } finally {
            await dispose();
          }
        }
        // The statusline file and the usage events land a moment after the reply.
        const settled = await until(
          read,
          (current) => current.status.state !== 'unknown',
          SETTLE_MS,
        );
        const entry = toEntry(id, settled.status, {
          source: SOURCE[id],
          turn: NEEDS_TURN[id],
          unknownReason: settled.unknownReason,
          unit:
            id === 'claude-code'
              ? 'percent 0..100 (utilization_unit: auto; fractions up to 1 are scaled)'
              : 'percent 0..100',
        });
        entries.push(entry);
        console.log(`[quota-real] ${JSON.stringify(entry)}`);
        expectValid(entry);
      } finally {
        await daemon.stop();
        // Only the link goes: the owner's profile is outside the temporary directory.
        await unlink(link).catch(() => undefined);
        await tmp.dispose();
      }
      expect(pids.filter(alive), `${id}: processes left`).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it('minimax: reads the Token Plan only when OT_TEST_MINIMAX_KEY_ENV names a variable with the key', async () => {
    const source = 'MiniMax Token Plan endpoint (the daemon call, under its network policy)';
    const keyEnv = value('OT_TEST_MINIMAX_KEY_ENV');
    if (keyEnv === undefined) {
      console.warn('[minimax] skipped: OT_TEST_MINIMAX_KEY_ENV is not set');
      entries.push({ client: 'minimax', source, skipped: 'OT_TEST_MINIMAX_KEY_ENV is not set' });
      return;
    }
    if (value(keyEnv) === undefined) {
      // The name is not a secret; the value never is printed.
      console.warn(`[minimax] skipped: the variable named by OT_TEST_MINIMAX_KEY_ENV is empty`);
      entries.push({
        client: 'minimax',
        source,
        skipped: 'the variable named by OT_TEST_MINIMAX_KEY_ENV is empty or unset',
      });
      return;
    }
    const means = value('OT_TEST_MINIMAX_USAGE_COUNT_MEANS') === 'used' ? 'used' : 'remaining';
    const clock = new SystemClock();
    const probe = new MiniMaxQuotaProbe({
      baseUrl: CONFIG.quota.minimax.base_url,
      network: { allowHosts: CONFIG.quota.minimax.allow_hosts, timeoutMs: 20_000 },
      usageCountMeans: means,
      keyOf: () => Promise.resolve(value(keyEnv)),
      clock,
      logger: createSilentLogger(),
    });
    const service = new QuotaService({
      store: new InMemoryStore({ clock }),
      clock,
      settings: quotaSettingsOf(CONFIG),
      logger: createSilentLogger(),
    });
    service.addProbe('minimax', probe);
    const ref: ProfileRef = { client: 'minimax', profile: 'real' };
    try {
      const status = await service.refresh(ref);
      let unknownReason: string | null = null;
      if (status.state === 'unknown') {
        unknownReason = await probe.read(ref).then(
          () => status.reason,
          (error: unknown) => reasonOf(error),
        );
      }
      const entry = toEntry('minimax', status, {
        source,
        turn: false,
        unknownReason,
        unit: `percent 0..100 (usage_count_means: ${means})`,
      });
      entries.push(entry);
      console.log(`[quota-real] ${JSON.stringify(entry)}`);
      expectValid(entry);
    } finally {
      await service.stop();
    }
  }, 60_000);
});
