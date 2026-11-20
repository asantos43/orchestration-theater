// SPDX-License-Identifier: MPL-2.0
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { ApiClient } from '@otheater/client';
import { API_ROUTES, type ApiSseMessage, type ChatServerMessage } from '@otheater/protocol';
import { FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { LIMIT_PRESET_NAMES, parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { RealHeadCodeHost, waitFor } from '../orchestration/e2e-fixture.js';
import { dataPaths, profileDirOf } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';

/**
 * The acceptance of Phase 6 at the REAL level (P13 of docs/17) [proposta]: one real client (Claude
 * Code with a small model) in every role of a play, and a client of `@otheater/client` that does
 * what a screen does: opens the scenario by REST, talks to the Director over the chat WebSocket,
 * answers its questions, and follows the play through the event stream until the delivery. Nothing
 * here runs by default: a plain `pnpm test` skips the file, so no client is started and no quota is
 * spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1` and `OT_TEST_REAL_PHASE6=1`, plus the
 * same variables as `orchestration/play.real.test.ts` (the profile is linked, never copied or
 * read): `OT_TEST_CLAUDE_PROFILE_DIR`, `OT_TEST_CLAUDE_MODEL`, and, optional,
 * `OT_TEST_CLAUDE_MODE`, `OT_TEST_PLAY_TIMEOUT_MS` (default 25 minutes) and `OT_TEST_PLAY_LIMITS`
 * (default `moderate`).
 *
 * The criteria are about what the client SAW, not about what the model wrote: the events the
 * stream delivered are exactly the events of the log (ids, no repeat), they hold the whole path to
 * DONE and the `delivery.completed`, REST says DONE, and the fake code host holds one PR. The code
 * host is the fake one (no GitHub); no process the test started is alive after the daemon stops.
 * [N] Not run when written: nothing here reads or prints a credential, and the owner runs it.
 */

const flags = realClientFlags();
const phase6Flag = process.env.OT_TEST_REAL_PHASE6 === '1';
const supported = process.platform !== 'win32';
const PROFILE_DIR = process.env.OT_TEST_CLAUDE_PROFILE_DIR ?? '';
const MODEL = process.env.OT_TEST_CLAUDE_MODEL ?? '';
const MODE = process.env.OT_TEST_CLAUDE_MODE;
const ready =
  flags.clients && flags.prompts && phase6Flag && supported && PROFILE_DIR !== '' && MODEL !== '';

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const TEARDOWN_MARGIN_MS = 3 * 60_000;
const ANSWER_FALLBACK = 'Use your best judgment and keep it as small as possible.';
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

function timeoutMs(): number {
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

function log(text: string): void {
  // `console.log` of a passing test is hidden by vitest; stderr is not.
  process.stderr.write(`[phase6-real] ${text}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

afterAll(disposeTestGitIsolation);

describe.skipIf(!ready)(
  'a play with real Claude Code followed by a client of the API (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PHASE6=1)',
  () => {
    const limitMs = ready ? timeoutMs() : DEFAULT_TIMEOUT_MS;

    it(
      'the client sees the whole play over SSE and chats with the Director over the WebSocket',
      async () => {
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
  preset: ${limitsPreset()}
orchestration:
  executor:
    client: claude-code
    profile: real
    model: ${JSON.stringify(MODEL)}
${MODE === undefined || MODE === '' ? '' : `    mode: ${JSON.stringify(MODE)}\n`}`);
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
          overrides: { vault: new InMemorySecretVault(), launcher, codeHost },
          clients: productionClients(config),
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        const rig = await makeWorkspaceRig({ store: daemon.store, codeHost });
        await writeFile(
          join(rig.repo, 'package.json'),
          `${JSON.stringify({ name: 'tiny-project', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
        );
        await testGit(rig.repo, 'add', '-A');
        await testGit(rig.repo, 'commit', '--quiet', '-m', 'the tiny project');
        await testGit(rig.repo, 'push', '--quiet', 'origin', 'main');
        fakeHost.seedRemote(rig.repo, 'main');

        const started = Date.now();
        const received: ApiSseMessage[] = [];
        const replies: string[] = [];
        let failure: unknown;
        let survivors: number[];
        // The token is the file of the daemon in the temporary folder: the test's own, not a client's.
        const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
        const client = new ApiClient({ url: daemon.api.url, token });
        const stream = client.events({ since: 0 });
        stream.onMessage((message) => received.push(message));
        let chat: ReturnType<ApiClient['chat']> | undefined;
        try {
          const opened = await client.call(API_ROUTES.openScenario, {
            body: { repo: rig.repo },
          });
          const scenarioId = opened.scenario.id;
          chat = client.chat(scenarioId, {});
          const answered = new Set<number>();
          chat.onMessage((frame: ChatServerMessage) => {
            if (frame.type === 'director_reply' && frame.final) replies.push(frame.text);
            if (frame.type === 'ask' && !answered.has(frame.eventId)) {
              answered.add(frame.eventId);
              const input = frame.input as { questions?: { options?: { label?: unknown }[] }[] };
              if (frame.kind === 'producer_question') {
                const answers = (input.questions ?? []).map((question) => {
                  const first = question.options?.[0]?.label;
                  return typeof first === 'string' && first !== '' ? first : ANSWER_FALLBACK;
                });
                chat?.send({ type: 'answer', decisionId: frame.decisionId, answer: { answers } });
              } else {
                // A menu is a limit that ran out: a failure of the run, so the play is cancelled.
                chat?.send({
                  type: 'answer',
                  decisionId: frame.decisionId,
                  answer: { option: 'cancel', reason: 'the real test gave up' },
                });
              }
            }
          });
          chat.start();
          await waitFor(
            'the chat to open',
            () => Promise.resolve(chat?.state === 'open' || undefined),
            60_000,
          );
          chat.send({ type: 'message', text: NEED });

          const finished = (): boolean =>
            received.some((message) => message.data.type === 'delivery.completed') ||
            received.some(
              (message) =>
                message.data.type === 'play.transitioned' &&
                ['DONE', 'CANCELLED', 'FAILED'].includes(
                  String((message.data.payload as { to?: unknown }).to),
                ),
            );
          await waitFor(
            'the play to end as the client sees it',
            () => Promise.resolve(finished() || undefined),
            limitMs,
          );

          // The stream is the log: same ids, in order, none twice.
          const head = await daemon.store.events.readFrom(0, 1_000_000);
          await waitFor(
            'the stream to reach the log',
            () => Promise.resolve(received.at(-1)?.data.id === head.at(-1)?.id || undefined),
            60_000,
          );
          expect(received.map((message) => message.data.id)).toEqual(head.map((event) => event.id));

          const playId = received.find((message) => message.data.type === 'play.created')?.data
            .playId;
          if (playId === undefined) throw new Error('the stream never showed play.created');
          const path = received
            .filter((message) => message.data.type === 'play.transitioned')
            .map((message) => String((message.data.payload as { to?: unknown }).to));
          expect(path.at(-1), `the play must reach DONE (path: ${path.join(' > ')})`).toBe('DONE');
          const delivered = received.find((message) => message.data.type === 'delivery.completed');
          expect(delivered, 'the client must see delivery.completed').toBeDefined();
          const delivery = delivered?.data.payload as { branch: string };
          expect((await client.call(API_ROUTES.getPlay, { params: { playId } })).play.state).toBe(
            'DONE',
          );
          const pulls = fakeHost.pullRequests();
          expect(pulls).toHaveLength(1);
          expect(pulls[0]).toMatchObject({ baseBranch: 'main', headBranch: delivery.branch });
          const files = (
            await testGit(rig.repo, 'ls-tree', '-r', '--name-only', delivery.branch)
          ).split('\n');
          for (const wanted of WANTED_FILES) expect(files).toContain(wanted);
          expect(replies.length, 'the Director must have answered the client').toBeGreaterThan(0);
          log(`play ${playId}: ${path.join(' > ')}`);
        } catch (error) {
          failure = error;
        } finally {
          log(
            `events seen by the client: ${String(received.length)}; Director replies: ${String(replies.length)}; total time: ${((Date.now() - started) / 1000).toFixed(1)}s (deadline ${(limitMs / 1000).toFixed(1)}s)`,
          );
          chat?.close();
          stream.close();
          await rig.dispose();
          await daemon.stop();
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
            : new Error('the phase 6 run failed', { cause: failure });
        }
        expect(pids.length).toBeGreaterThan(0);
        expect(survivors).toEqual([]);
      },
      limitMs + TEARDOWN_MARGIN_MS,
    );
  },
);
