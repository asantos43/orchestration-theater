// SPDX-License-Identifier: MPL-2.0
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  EventEnvelope,
  LaunchedProcess,
  LaunchOptions,
  PlayRecord,
  ProcessLauncher,
} from '@otheater/core';
import { FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { LIMIT_PRESET_NAMES, parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths, profileDirOf } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';
import { RealHeadCodeHost, waitFor } from './e2e-fixture.js';

/**
 * A whole play (architecture 5.4) with REAL clients (N57, N88; P13). Nothing here runs by default:
 * a plain `pnpm test` skips the file, so no client is started and no quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1` and `OT_TEST_REAL_PLAY=1`, plus:
 * - `OT_TEST_CLAUDE_PROFILE_DIR`: a logged-in Claude Code profile. The test points the profile of
 *   the play at it with a symlink inside the temporary data directory: it never copies, reads or
 *   deletes what is in it (the pattern of `acceptance.real.test.ts`, where the profile is used as
 *   is);
 * - `OT_TEST_CLAUDE_MODEL`: the model id the client lists (a Haiku one is enough; the test does
 *   not guess it);
 * - `OT_TEST_CLAUDE_MODE` (optional): the mode id that lets the client call an MCP tool and edit
 *   a file without asking. With `onAsk: 'reject'` an ask is refused (architecture 5.8), so a
 *   mode that asks for every tool makes the play fail on the first one. The tools of the MCP
 *   servers of each role are the exception: the adapter allows them with `allowedTools` and
 *   `permissions.allow` (`mcp__<server>`), whatever the mode;
 * - `OT_TEST_PLAY_TIMEOUT_MS` (optional): the total deadline of the play, in milliseconds. Default
 *   25 minutes; the `play` level of `tools/acceptance/real-acceptance.sh` kills the run after 30;
 * - `OT_TEST_PLAY_LIMITS` (optional): the `limits.preset` of the play (`economical`, `moderate` or
 *   `persistent`). Default `moderate`, the preset the product has when nothing is written.
 *
 * Every role (Director, author, reviewers, Actor, Critic) is Claude Code through
 * `claude-agent-acp`, with the model above. The code host is the fake one: no GitHub, no `gh`, and
 * the PR the delivery opens exists only in memory. The project is a temporary git repository with a
 * `node --test` check; the Producer asks for one small function and its test.
 *
 * The criteria are about the outcome, not about what the model wrote: the play ends in DONE with
 * `delivery.completed`, the fake code host holds the PR, the delivered branch has the two files
 * the Producer asked for, and no process the test started is alive after the daemon stopped. The
 * summary of states, attempts, time and usage goes to stderr, passing or not.
 *
 * [proposta] It runs with `security.unenforced: warn` (no sandbox before Phase 4), like
 * `acceptance.real.test.ts`. The `verify` step runs the project's check as the daemon user, in the
 * worktree of the demand, with no sandbox: the project here is the test's own and tiny.
 * [N] Not run in this step: written to be run by the owner. Nothing here reads or prints a
 * credential, and the token of each session only travels to its client.
 */

const flags = realClientFlags();
const playFlag = process.env.OT_TEST_REAL_PLAY === '1';
const supported = process.platform !== 'win32';

const PROFILE_DIR = process.env.OT_TEST_CLAUDE_PROFILE_DIR ?? '';
const MODEL = process.env.OT_TEST_CLAUDE_MODEL ?? '';
const MODE = process.env.OT_TEST_CLAUDE_MODE;
const ready =
  flags.clients && flags.prompts && playFlag && supported && PROFILE_DIR !== '' && MODEL !== '';

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
/** What the test needs after the deadline: stopping the daemon and the processes, removing files. */
const TEARDOWN_MARGIN_MS = 3 * 60_000;
const POLL_MS = 2_000;
/**
 * How long the test waits, after the Director answered with text and no play is open and nothing
 * waits for the Producer, before it fails with "answered without opening a play". Ninety seconds
 * is a margin over the gap between two turns of the Director; the play itself takes minutes.
 */
const NO_PLAY_GRACE_MS = 90_000;
/** How much of each reply of the Director goes into the notes. */
const REPLY_NOTE_CHARS = 600;

function playTimeoutMs(): number {
  const raw = process.env.OT_TEST_PLAY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60_000) {
    throw new Error(`OT_TEST_PLAY_TIMEOUT_MS must be an integer of at least 60000, got "${raw}"`);
  }
  return value;
}

function limitsPreset(): string {
  const raw = process.env.OT_TEST_PLAY_LIMITS;
  if (raw === undefined || raw === '') return 'moderate';
  if (!(LIMIT_PRESET_NAMES as readonly string[]).includes(raw)) {
    throw new Error(
      `OT_TEST_PLAY_LIMITS must be one of ${LIMIT_PRESET_NAMES.join(', ')}, got "${raw}"`,
    );
  }
  return raw;
}

/** The files of the project: only what `node --test` needs, no dependencies and no install. */
const PROJECT_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify(
    { name: 'tiny-project', private: true, type: 'module', scripts: { test: 'node --test' } },
    null,
    2,
  )}\n`,
  'README.md': '# Tiny project\n\nPlain JavaScript modules, tested with `node --test`.\n',
};

/** The two files the Producer asks for; the criterion looks for them on the delivered branch. */
const WANTED_FILES = ['src/slugify.js', 'src/slugify.test.js'] as const;

const NEED = [
  'Add to this project a function slugify(text) that turns a text into a URL slug:',
  'lower case, accents removed, every run of characters that are not letters or digits becomes',
  'one hyphen, and no hyphen at the start or at the end.',
  `Put the function, exported by name, in ${WANTED_FILES[0]} (an ES module) and its tests in`,
  `${WANTED_FILES[1]}, written with the node:test module and node:assert/strict.`,
  'The project has no dependencies and nothing to install: the check is the command',
  '"node --test" run in the root of the project, and it must pass.',
  'This is the whole need: do not ask me anything else, and do not touch other files.',
].join(' ');

/** What the test tells the Director when it asks for something: the choice that moves on. */
const ANSWER_FALLBACK = 'Use your best judgment and keep it as small as possible.';

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

function log(text: string): void {
  // `console.log` of a passing test is hidden by vitest; stderr is not.
  process.stderr.write(`[play-real] ${text}\n`);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * What the `usage` updates of the sessions add up to. [N] Whether a client reports the usage of a
 * turn or the running total of the session is not confirmed: the sum may count a session more than
 * once, so the figures are an upper bound, not a bill. The `last` figures keep only the final
 * update of each session, which is exact if the update is cumulative.
 */
function usageOf(events: readonly EventEnvelope[]): { sum: UsageTotals; last: UsageTotals } {
  const empty = (): UsageTotals => ({
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
  const sum = empty();
  const lastBySession = new Map<string, Partial<UsageTotals>>();
  for (const event of events) {
    if (event.type !== 'session.update') continue;
    const payload = event.payload as { sessionId?: string; update?: Record<string, unknown> };
    const update = payload.update;
    if (update?.kind !== 'usage') continue;
    const numbers: Partial<UsageTotals> = {};
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    ] as const) {
      const value = update[key];
      if (typeof value === 'number') {
        numbers[key] = value;
        sum[key] += value;
      }
    }
    sum.turns += 1;
    lastBySession.set(payload.sessionId ?? `event-${String(event.id)}`, numbers);
  }
  const last = empty();
  for (const numbers of lastBySession.values()) {
    last.turns += 1;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    ] as const) {
      last[key] += numbers[key] ?? 0;
    }
  }
  return { sum, last };
}

/**
 * How many `tool_call_update` events of the play end with status `failed`. The `session.update`
 * events come from the attempt runner only (`attempt-runner.ts`); the Director's updates are read
 * for the text of its reply and never recorded, so a refused MCP call of the Director does not
 * show here: its replies, in the notes, are what is left. A refused permission is not told apart
 * from other failures: the normalized update has the status, not the reason.
 */
function failedToolCalls(events: readonly EventEnvelope[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== 'session.update') continue;
    const update = (event.payload as { update?: { kind?: unknown; status?: unknown } }).update;
    if (update?.kind === 'tool_call_update' && update.status === 'failed') count += 1;
  }
  return count;
}

function describeUsage(label: string, totals: UsageTotals): string {
  return (
    `${label}: ${String(totals.turns)} updates, in ${String(totals.inputTokens)}, ` +
    `out ${String(totals.outputTokens)}, cache read ${String(totals.cacheReadTokens)}, ` +
    `cache write ${String(totals.cacheWriteTokens)}, cost USD ${totals.costUsd.toFixed(4)}`
  );
}

afterAll(disposeTestGitIsolation);

describe.skipIf(!ready)(
  'a play with real Claude Code in every role (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PLAY=1)',
  () => {
    const timeoutMs = ready ? playTimeoutMs() : DEFAULT_TIMEOUT_MS;

    it(
      'delivers a small task: PR on the fake code host, the requested files on the branch, no orphan process',
      async () => {
        const preset = limitsPreset();
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const { launcher, pids } = recording(real);
        const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  preset: ${preset}
orchestration:
  executor:
    client: claude-code
    profile: real
    model: ${JSON.stringify(MODEL)}
${MODE === undefined || MODE === '' ? '' : `    mode: ${JSON.stringify(MODE)}\n`}`);

        // The profile of the play is the owner's logged-in one: a link, never a copy.
        const profileDir = profileDirOf(dataPaths(tmp.dir), {
          client: 'claude-code',
          profile: 'real',
        });
        await mkdir(join(profileDir, '..'), { recursive: true });
        await symlink(PROFILE_DIR, profileDir, 'dir');

        const fakeHost = new FakeCodeHost();
        const codeHost = new RealHeadCodeHost(fakeHost);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config,
          // The clock is the real one: the stuck and the timeout detection of the daemon need it.
          overrides: { vault: new InMemorySecretVault(), launcher, codeHost },
          clients: productionClients(config),
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        const rig = await makeWorkspaceRig({ store: daemon.store, codeHost });
        for (const [name, content] of Object.entries(PROJECT_FILES)) {
          await writeFile(join(rig.repo, name), content);
        }
        await testGit(rig.repo, 'add', '-A');
        await testGit(rig.repo, 'commit', '--quiet', '-m', 'the tiny project');
        await testGit(rig.repo, 'push', '--quiet', 'origin', 'main');
        fakeHost.seedRemote(rig.repo, 'main');

        const started = Date.now();
        const notes: string[] = [];
        let playRecord: PlayRecord | undefined;
        let survivors: number[];
        let failure: unknown;
        try {
          const { producer } = daemon;
          if (producer === undefined) throw new Error('the daemon has no Producer channel');
          const { scenarioId } = await producer.openChat({ repo: rig.repo });
          await producer.send(scenarioId, NEED);

          // The Producer's side: the questions of the Director get a generic answer so the play
          // goes on; a menu means a counter ran out, which is a failure of the run, so it is
          // recorded and cancelled (the criteria below then fail with a clear summary).
          const answered = new Set<string>();
          const deadline = started + timeoutMs;
          // The cursor of the replies of the Director (`since`) keeps each one from coming twice.
          let since = 0;
          let directorReplied = false;
          // Since when the Director has answered, no play is open and nothing waits for us.
          let idleSince: number | undefined;
          for (;;) {
            const poll = await producer.poll(scenarioId, since);
            for (const reply of poll.replies) {
              since = Math.max(since, reply.seq);
              directorReplied = true;
              notes.push(
                `Director reply #${String(reply.seq)} to ${reply.to}: ${clip(reply.text, REPLY_NOTE_CHARS)}`,
              );
            }
            for (const ask of poll.asks) {
              if (answered.has(ask.id)) continue;
              answered.add(ask.id);
              if (ask.kind === 'producer_question') {
                const questions = Array.isArray(ask.input.questions) ? ask.input.questions : [];
                const answers = questions.map((item) => {
                  const options = (item as { options?: { label?: unknown }[] }).options;
                  const first = options?.[0]?.label;
                  return typeof first === 'string' && first !== '' ? first : ANSWER_FALLBACK;
                });
                notes.push(`the Director asked ${String(questions.length)} question(s): answered`);
                await producer.answer(ask.id, { answers });
              } else {
                const reason = typeof ask.input.reason === 'string' ? ask.input.reason : '';
                notes.push(`menu "${ask.kind}" in ${ask.playId ?? '?'}: ${reason}; cancelled`);
                await producer.answer(ask.id, {
                  option: 'cancel',
                  reason: 'the real test gave up',
                });
              }
            }
            playRecord = (await daemon.store.plays.list({ scenarioId }))[0];
            if (playRecord?.finishedAt !== null && playRecord?.finishedAt !== undefined) break;
            if (Date.now() > deadline) break;
            // Fail early: a Director that answered in text and opened nothing will not open a play
            // by waiting; the notes say what it answered.
            const waiting =
              playRecord === undefined &&
              directorReplied &&
              poll.plays.length === 0 &&
              poll.asks.length === 0 &&
              !poll.busy;
            if (!waiting) {
              idleSince = undefined;
            } else {
              idleSince ??= Date.now();
              if (Date.now() - idleSince >= NO_PLAY_GRACE_MS) {
                throw new Error(
                  `the Director answered without opening a play (${seconds(NO_PLAY_GRACE_MS)} of grace; see the notes)`,
                );
              }
            }
            await sleep(POLL_MS);
          }

          // What the criteria need, read before the summary.
          const finished = playRecord;
          if (finished === undefined) {
            throw new Error(
              'the Director never opened a play: it answered with text only (see the notes)',
            );
          }
          const events = (await daemon.store.events.readFrom(0, 1_000_000)).filter(
            (event) => event.playId === finished.id,
          );
          const state = (await daemon.store.plays.get(finished.id))?.state ?? finished.state;
          expect(state, `the play must reach DONE (notes: ${notes.join(' | ')})`).toBe('DONE');

          const delivered = events.find((event) => event.type === 'delivery.completed');
          expect(delivered, 'the play must record delivery.completed').toBeDefined();
          const delivery = delivered?.payload as {
            branch: string;
            pullRequest?: { number: number };
          };
          const pulls = fakeHost.pullRequests();
          expect(pulls).toHaveLength(1);
          expect(pulls[0]).toMatchObject({ baseBranch: 'main', headBranch: delivery.branch });
          expect(delivery.pullRequest?.number).toBe(pulls[0]?.number);

          const files = (
            await testGit(rig.repo, 'ls-tree', '-r', '--name-only', delivery.branch)
          ).split('\n');
          for (const wanted of WANTED_FILES) {
            expect(files, `the branch ${delivery.branch} must have ${wanted}`).toContain(wanted);
            const content = await testGit(rig.repo, 'show', `${delivery.branch}:${wanted}`);
            expect(content.trim(), `${wanted} must not be empty`).not.toBe('');
          }
        } catch (error) {
          failure = error;
        } finally {
          // The summary comes first, so a failure still tells what happened.
          try {
            const id = playRecord?.id;
            if (id !== undefined) {
              const events = (await daemon.store.events.readFrom(0, 1_000_000)).filter(
                (event) => event.playId === id,
              );
              const transitions = events.filter((event) => event.type === 'play.transitioned');
              const path = transitions
                .map(
                  (event) =>
                    `${(event.payload as { to: string }).to}@${seconds(event.timestamp - started)}`,
                )
                .join(' > ');
              const attempts = (await daemon.store.attempts.list()).filter(
                (attempt) => attempt.playId === id,
              );
              const demands = await daemon.store.demands.list({ playId: id });
              const submitted = events.filter((event) => event.type === 'attempt.submitted').length;
              const usage = usageOf(events);
              const failedCalls = failedToolCalls(events);
              log(`play ${id}: state ${(await daemon.store.plays.get(id))?.state ?? '?'}`);
              log(`path: ${path || '(no transition)'}`);
              log(
                `attempts: ${String(attempts.length)} (${attempts
                  .map((a) => `${a.demandId}#${String(a.attempt)}:${a.state}`)
                  .join(', ')}); submits: ${String(submitted)}`,
              );
              log(`demands: ${demands.map((d) => `${d.id}:${d.state}`).join(', ') || '(none)'}`);
              log(
                `tool calls that ended failed in the recorded sessions: ${String(failedCalls)} ` +
                  '(attempt sessions only: the updates of the Director are not in the event log)',
              );
              log(describeUsage('usage, sum of the updates [N]', usage.sum));
              log(describeUsage('usage, last update of each session [N]', usage.last));
            } else {
              log('no play was opened');
            }
            for (const note of notes) log(`note: ${note}`);
            log(`total time: ${seconds(Date.now() - started)} (deadline ${seconds(timeoutMs)})`);
          } catch (error) {
            log(`could not build the summary: ${String(error)}`);
          }
          await rig.dispose();
          await daemon.stop();
          // Only the link goes: `rm -r` on the data directory would not follow it, but a link
          // removed by hand leaves no doubt about the owner's profile.
          await unlink(profileDir).catch(() => undefined);
          await tmp.dispose();
          survivors = await waitFor(
            'the processes of the clients to exit',
            () => Promise.resolve(pids.some(alive) ? undefined : []),
            15_000,
          ).catch(() => pids.filter(alive));
          log(`processes started: ${String(pids.length)}; left alive: ${String(survivors.length)}`);
        }
        if (failure !== undefined) {
          throw failure instanceof Error
            ? failure
            : new Error('the play run failed', { cause: failure });
        }
        expect(pids.length).toBeGreaterThan(0);
        expect(survivors).toEqual([]);
      },
      timeoutMs + TEARDOWN_MARGIN_MS,
    );
  },
);
