// SPDX-License-Identifier: MPL-2.0
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { ApiClient } from '@otheater/client';
import { API_ROUTES, type ApiSseMessage, type ChatServerMessage } from '@otheater/protocol';
import { FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { CLIENT_IDS, LIMIT_PRESET_NAMES, parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { RealHeadCodeHost, waitFor } from '../orchestration/e2e-fixture.js';
import { dataPaths, profileDirOf, type ProfileNames } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';
import {
  checkTurnTimeoutRun,
  measurementSettled,
  readTurnTimeoutSetting,
  summarizeTurnTimeouts,
} from './phase6-turn-timeout.js';
import { summarizeSessionUpdates, type SummarizableEvent } from './phase6-update-summary.js';

/**
 * The acceptance of Phase 6 at the REAL level (P13 of docs/17) [proposta]: one real client (with a
 * small model) in every role of a play, and a client of `@otheater/client` that does what a screen
 * does: opens the scenario by REST, talks to the Director over the chat WebSocket, answers its
 * questions, and follows the play through the event stream until the delivery. Nothing here runs
 * by default: a plain `pnpm test` skips the file, so no client is started and no quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1` and `OT_TEST_REAL_PHASE6=1`. The client
 * is `OT_TEST_PHASE6_CLIENT` (`claude-code`, the default, `codex` or `opencode`), with the
 * variables of that client (the profile is pointed at, never copied or read):
 * `OT_TEST_<CLAUDE|CODEX|OPENCODE>_PROFILE_DIR` and `_MODEL`, and, optional, `_MODE`. Also
 * optional: `OT_TEST_PLAY_TIMEOUT_MS` (default 25 minutes), `OT_TEST_PLAY_LIMITS` (default
 * `moderate`) and `OT_TEST_SANDBOX_EXTRA_DOMAINS` (comma-separated domains for
 * `sandbox.extra_domains`, for the provider of OpenCode) and `OT_TEST_PHASE6_EDIT_RULES=1`, which
 * gives the roles that write (actor and consultant) `on_ask: rules` with one rule that allows the
 * `edit` kind inside the worktree. That is the test-only stand-in of N180 for the clients with no
 * mode that edits with no request (Codex and OpenCode); N99 still refuses an edit outside the
 * worktree before the rules. Without it, every request of those clients is rejected.
 *
 * Measuring the turn limit with a real client (N184): `OT_TEST_TURN_TIMEOUT` (a duration as
 * `limits.turn_timeout` takes it, for example `20s`; the schema has no minimum above 1 ms, but it
 * must not exceed `demand_timeout`) and, optional, `OT_TEST_ON_TURN_TIMEOUT` (`cancel`, the default
 * when the first is set, `notice` or `off`) go into the `limits:` of the configuration. With the
 * first one set the test is in "turn limit measurement mode": it does not need the play to reach
 * DONE. It waits for the first `session.turn_timeout` (or the end of the play), lets the cut show
 * its consequences for {@link SETTLE_MS}, and then requires: at least one `session.turn_timeout`
 * with the limit and the action that were set (none with `off`); with `cancel`, a `session.closed`
 * after the cut of every attempt session; no process of the test alive at the end; and a daemon
 * that stops without error. The log gets each `session.turn_timeout` (session, role, limit,
 * elapsed, action), the final state of the play and what followed the cut (`ACTOR_TIMED_OUT`,
 * `SUBMIT_FAILED`, the transitions, the replies of the Director). Without the variable the test
 * is the one below, unchanged.
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
/** The prefix of the variables of each client: `OT_TEST_<prefix>_PROFILE_DIR`, `_MODEL`, `_MODE`. */
const ENV_PREFIX: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE',
  codex: 'OT_TEST_CODEX',
  opencode: 'OT_TEST_OPENCODE',
};
const RAW_CLIENT = process.env.OT_TEST_PHASE6_CLIENT ?? '';
const CLIENT: ClientId | undefined =
  RAW_CLIENT === ''
    ? 'claude-code'
    : (CLIENT_IDS as readonly string[]).includes(RAW_CLIENT)
      ? (RAW_CLIENT as ClientId)
      : undefined;
const prefix = ENV_PREFIX[CLIENT ?? 'claude-code'];
const PROFILE_DIR = process.env[`${prefix}_PROFILE_DIR`] ?? '';
const MODEL = process.env[`${prefix}_MODEL`] ?? '';
const MODE = process.env[`${prefix}_MODE`];
const EXTRA_DOMAINS = (process.env.OT_TEST_SANDBOX_EXTRA_DOMAINS ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter((domain) => domain !== '');
const EDIT_RULES = process.env.OT_TEST_PHASE6_EDIT_RULES === '1';
/** `roles.<role>.policy` for the roles that write, when {@link EDIT_RULES} is on. */
const EDIT_RULES_YAML = ['actor', 'consultant']
  .map(
    (role) =>
      `  ${role}:\n    policy:\n      on_ask: rules\n      rules:\n        - { id: edit-in-worktree, action: allow, kind: edit, path: "**" }\n`,
  )
  .join('');
/** Measuring the turn limit (`OT_TEST_TURN_TIMEOUT`); `undefined` is the ordinary run. */
const TURN_SETTING = phase6Flag ? readTurnTimeoutSetting(process.env) : undefined;
if (phase6Flag && CLIENT === undefined) {
  throw new Error(
    `OT_TEST_PHASE6_CLIENT must be one of ${CLIENT_IDS.join(', ')}, got "${RAW_CLIENT}"`,
  );
}
const ready =
  flags.clients && flags.prompts && phase6Flag && supported && PROFILE_DIR !== '' && MODEL !== '';

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const TEARDOWN_MARGIN_MS = 3 * 60_000;
/** In the measurement mode, how long the consequences of the first cut have to show up in the log. */
const SETTLE_MS = 60_000;
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

/** How long a Director that answered in text, with no play and nothing pending, may stay so. */
const NO_PLAY_GRACE_MS = 90_000;
/** How much of each reply of the Director goes into the notes. */
const REPLY_NOTE_CHARS = 600;
/**
 * The events whose payload goes into the summary, clipped: what each role delivered, why the play
 * moved, what was asked and what the tools answered. The run of 2026-11-20 ended with an empty
 * diff and a refused classification, and the log said only how many events of each type there
 * were. `session.update` (the stream of the models) stays out: it is most of the log.
 */
const TRACED_EVENTS = new Set([
  'play.transitioned',
  'attempt.submitted',
  'attempt.submit_failed',
  'attempt.aborted',
  'permission.asked',
  'permission.answered',
  'tool.called',
  'tool.finished',
  'workspace.integrated',
  'chat.director_silent',
]);
const TRACE_CHARS = 400;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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
  `a play with real ${CLIENT ?? '?'} followed by a client of the API (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PHASE6=1)`,
  () => {
    const limitMs = ready ? timeoutMs() : DEFAULT_TIMEOUT_MS;

    it(
      'the client sees the whole play over SSE and chats with the Director over the WebSocket',
      async () => {
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const { launcher, pids } = recording(real);
        const executor = CLIENT ?? 'claude-code';
        log(
          `client: ${executor}, model: ${MODEL}${MODE === undefined || MODE === '' ? '' : `, mode: ${MODE}`}${EDIT_RULES ? ', edit rules: on' : ''}`,
        );
        if (TURN_SETTING !== undefined) {
          log(
            `turn limit measurement: limits.turn_timeout ${TURN_SETTING.text} (${String(TURN_SETTING.ms)} ms), on_turn_timeout ${TURN_SETTING.action}; the play does not have to reach DONE`,
          );
        }
        const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  preset: ${limitsPreset()}
${TURN_SETTING === undefined ? '' : `  turn_timeout: ${JSON.stringify(TURN_SETTING.text)}\n  on_turn_timeout: ${TURN_SETTING.action}\n`}${EXTRA_DOMAINS.length === 0 ? '' : `sandbox:\n  extra_domains: ${JSON.stringify(EXTRA_DOMAINS)}\n`}${EDIT_RULES ? `roles:\n${EDIT_RULES_YAML}` : ''}orchestration:
  executor:
    client: ${executor}
    profile: real
    model: ${JSON.stringify(MODEL)}
${MODE === undefined || MODE === '' ? '' : `    mode: ${JSON.stringify(MODE)}\n`}`);
        // The profile of the play is the owner's logged-in one, pointed at by the test seam of the
        // daemon (`overrides.profileDir`): never a copy, and no link inside the data directory. The
        // sandbox (layer 3, on by default) denies `<data>` and does not follow a link there when it
        // reads the profile again, so a linked profile has no login inside it (2026-11-20).
        const profileSource = await realpath(PROFILE_DIR);
        const profileDir = (ref: ProfileNames): string =>
          ref.client === executor && ref.profile === 'real'
            ? profileSource
            : profileDirOf(dataPaths(tmp.dir), ref);

        const fakeHost = new FakeCodeHost();
        const codeHost = new RealHeadCodeHost(fakeHost);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config,
          overrides: { vault: new InMemorySecretVault(), launcher, codeHost, profileDir },
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
        const replyAt: number[] = [];
        let failure: unknown;
        let stopFailure: unknown;
        let survivors: number[];
        // The token is the file of the daemon in the temporary folder: the test's own, not a client's.
        const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
        const client = new ApiClient({ url: daemon.api.url, token });
        const notes: string[] = [];
        let scenarioId: string | undefined;
        const stream = client.events({ since: 0 });
        stream.onMessage((message) => received.push(message));
        // The stream opens only when started (the first run of this test, 2026-11-20, missed it
        // and the client saw no event at all).
        stream.start();
        let chat: ReturnType<ApiClient['chat']> | undefined;
        try {
          const opened = await client.call(API_ROUTES.openScenario, {
            body: { repo: rig.repo },
          });
          scenarioId = opened.scenario.id;
          chat = client.chat(scenarioId, {});
          // By decision, not by event: the asks pending when the chat opens share one event id.
          const answered = new Set<string>();
          chat.onMessage((frame: ChatServerMessage) => {
            if (frame.type === 'director_reply' && frame.final) {
              replies.push(frame.text);
              replyAt.push(Date.now());
              notes.push(
                `Director reply #${String(replies.length)}@${seconds(Date.now() - started)}: ${clip(frame.text, REPLY_NOTE_CHARS)}`,
              );
            }
            if (frame.type === 'ask' && !answered.has(frame.decisionId)) {
              answered.add(frame.decisionId);
              const input = frame.input as { questions?: { options?: { label?: unknown }[] }[] };
              if (frame.kind === 'producer_question') {
                const answers = (input.questions ?? []).map((question) => {
                  const first = question.options?.[0]?.label;
                  return typeof first === 'string' && first !== '' ? first : ANSWER_FALLBACK;
                });
                notes.push(
                  `question@${seconds(Date.now() - started)} (${String(answers.length)}): answered`,
                );
                chat?.send({ type: 'answer', decisionId: frame.decisionId, answer: { answers } });
              } else {
                // A menu is a limit that ran out: a failure of the run, so the play is cancelled.
                notes.push(
                  `menu "${frame.kind}"@${seconds(Date.now() - started)} in ${frame.playId ?? '?'}: cancelled`,
                );
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
          // The envelopes the stream delivered are the events of the log (checked below).
          const seen = (): SummarizableEvent[] => received.map((message) => message.data);
          const { producer } = daemon;
          if (producer === undefined) throw new Error('the daemon has no Producer channel');
          const deadline = started + limitMs;
          // Since when the Director has answered, no play is open and nothing waits for us.
          let idleSince: number | undefined;
          // The measurement mode ends on the first cut and its consequences, or on the end of the play.
          while (
            TURN_SETTING === undefined
              ? !finished()
              : !finished() && !measurementSettled(seen(), Date.now(), SETTLE_MS)
          ) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for the play to end as the client sees it');
            }
            // Fail early: a Director that answered in text and opened nothing will not open a play
            // by waiting; the notes say what it answered. `state` has no side effect.
            const state = await producer.state(scenarioId);
            const plays = await daemon.store.plays.list({ scenarioId });
            const waiting =
              plays.length === 0 && replies.length > 0 && state.asks.length === 0 && !state.busy;
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
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }

          // The stream is the log: same ids, in order, none twice.
          const head = await daemon.store.events.readFrom(0, 1_000_000);
          // With the play over, nothing is written any more and the two are equal. In the
          // measurement mode the play may still be running: the stream holds the log as a prefix.
          await waitFor(
            'the stream to reach the log',
            () =>
              Promise.resolve(
                (TURN_SETTING === undefined
                  ? received.at(-1)?.data.id === head.at(-1)?.id
                  : received.length >= head.length) || undefined,
              ),
            60_000,
          );
          expect(
            (TURN_SETTING === undefined ? received : received.slice(0, head.length)).map(
              (message) => message.data.id,
            ),
          ).toEqual(head.map((event) => event.id));

          if (TURN_SETTING !== undefined) {
            // No DONE needed: the criteria are about the turn limit. The play may still be open;
            // stopping the daemon below is the check that it stops with it open.
            const problems = checkTurnTimeoutRun(head, TURN_SETTING);
            expect(problems, `the turn limit measurement:\n${problems.join('\n')}`).toEqual([]);
          } else {
            const playId = received.find((message) => message.data.type === 'play.created')?.data
              .playId;
            if (playId === undefined) throw new Error('the stream never showed play.created');
            const path = received
              .filter((message) => message.data.type === 'play.transitioned')
              .map((message) => String((message.data.payload as { to?: unknown }).to));
            expect(path.at(-1), `the play must reach DONE (path: ${path.join(' > ')})`).toBe(
              'DONE',
            );
            const delivered = received.find(
              (message) => message.data.type === 'delivery.completed',
            );
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
          }
        } catch (error) {
          failure = error;
        } finally {
          // The summary comes first, so a failure still tells what happened: the log of the
          // daemon (types and counts only, no payload) and the path of each play.
          try {
            const events = await daemon.store.events.readFrom(0, 1_000_000);
            const counts = new Map<string, number>();
            for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
            log(
              `events in the log: ${String(events.length)} (${[...counts]
                .map(([type, count]) => `${type} ${String(count)}`)
                .join(', ')})`,
            );
            const plays =
              scenarioId === undefined ? [] : await daemon.store.plays.list({ scenarioId });
            for (const play of plays) {
              const path = events
                .filter((event) => event.playId === play.id && event.type === 'play.transitioned')
                .map(
                  (event) =>
                    `${String((event.payload as { to?: unknown }).to)}@${seconds(event.timestamp - started)}`,
                )
                .join(' > ');
              log(`play ${play.id} (${play.state}): ${path}`);
            }
            for (const event of events) {
              if (!TRACED_EVENTS.has(event.type)) continue;
              log(
                `trace ${event.type}@${seconds(event.timestamp - started)}: ${clip(JSON.stringify(event.payload), TRACE_CHARS)}`,
              );
            }
            // The measurement of the turn limit: each cut and what followed it, the final state of
            // the play and the replies of the Director after the first cut.
            if (TURN_SETTING !== undefined) {
              try {
                const lines = summarizeTurnTimeouts(events, {
                  prefix: 'measure: ',
                  startedAt: started,
                });
                for (const line of lines) log(line);
                log(
                  `measure: final state of the play: ${plays.length === 0 ? 'no play' : plays.map((play) => `${play.id} ${play.state}`).join(', ')}`,
                );
                const firstCut = events.find((event) => event.type === 'session.turn_timeout');
                const after =
                  firstCut === undefined
                    ? []
                    : replyAt.filter((time) => time >= firstCut.timestamp);
                log(
                  `measure: Director replies after the first turn_timeout: ${String(after.length)} of ${String(replyAt.length)}${after.length === 0 ? '' : ` (at ${after.map((time) => seconds(time - started)).join(', ')}; the text is in the notes)`}`,
                );
              } catch (error) {
                log(`the summary of the turn limit failed: ${String(error)}`);
              }
            }
            // What the `session.update` events were, per session: kinds, tools and the end of the
            // stream (kinds, tool names and statuses only, never content). Apart from the summary
            // above, so a failure here only costs this block.
            try {
              for (const line of summarizeSessionUpdates(events)) log(line);
            } catch (error) {
              log(`the diagnosis of the session updates failed: ${String(error)}`);
            }
          } catch (error) {
            log(`the summary of the log failed: ${String(error)}`);
          }
          for (const note of notes) log(note);
          // Whether the Director still had a turn running (or a prompt queued) when the play ended:
          // a real round with no reply and no `chat.director_silent` (N183) points to a turn that
          // had not ended yet, not to a silent one. Once the play has ended, `busy` is that and the
          // rare idea work of the scenario.
          if (scenarioId !== undefined && daemon.producer !== undefined) {
            try {
              const { busy } = await daemon.producer.state(scenarioId);
              log(
                `Director busy at the end (a turn running or a prompt queued): ${busy ? 'yes' : 'no'}`,
              );
            } catch (error) {
              log(`the state of the Director could not be read: ${String(error)}`);
            }
          }
          log(
            `events seen by the client: ${String(received.length)}; Director replies: ${String(replies.length)}; total time: ${((Date.now() - started) / 1000).toFixed(1)}s (deadline ${(limitMs / 1000).toFixed(1)}s)`,
          );
          chat?.close();
          stream.close();
          await rig.dispose();
          try {
            await daemon.stop();
          } catch (error) {
            stopFailure = error;
            log(`the daemon did not stop clean: ${String(error)}`);
          }
          await tmp.dispose();
          survivors = await waitFor(
            'the processes of the clients to exit',
            () => Promise.resolve(pids.some(alive) ? undefined : []),
            15_000,
          ).catch(() => pids.filter(alive));
          log(`processes started: ${String(pids.length)}; left alive: ${String(survivors.length)}`);
        }
        if (stopFailure !== undefined) {
          failure ??= new Error('the daemon did not stop clean', { cause: stopFailure });
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
