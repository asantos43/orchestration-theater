// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import {
  NO_LAUNCHER,
  startChatDaemon,
  waitUntil,
  type ChatDaemon,
} from './chat/fake-agent.test-support.js';
import { PANE_TERM, TmuxSession, detectTmux } from './tmux.test-support.js';

/**
 * The acceptance of Phase 7 at the REAL level (P21 of docs/18) [proposta]: the compiled TUI runs in
 * a real tmux (a server and a socket of its own, as `tmux.smoke.test.ts` does) against a daemon in
 * this process that has Claude Code (a small model) in every role. The test does what a person
 * does, by keys only: asks for the need in the chat, answers what the Director asks and chooses
 * "Open a pull request" on the delivery card, until the play is DONE and the fake code host holds
 * the pull request. Nothing here runs by default: a plain `pnpm test` skips the file, so no client
 * is started and no quota is spent.
 *
 * Needs `OT_TEST_REAL_CLIENTS=1`, `OT_TEST_REAL_PROMPTS=1`, `OT_TEST_REAL_PHASE7=1`, and the profile
 * of Claude Code that is already logged in: `OT_TEST_CLAUDE_PROFILE_DIR` (pointed at, never copied
 * or read: the daemon hands the folder to the client) and `OT_TEST_CLAUDE_MODEL` (for example
 * `haiku`). Optional: `OT_TEST_PLAY_TIMEOUT_MS` (default 25 minutes). Also needs `tmux` and the
 * build (`pnpm build`).
 *
 * What it proves: the TUI process, its keys and its cards, over the real chat with a real Director
 * and real Executors, and that when the TUI quits and the daemon stops no process the test started
 * is left alive (the pane's tree and the processes of the clients). What it does not prove: the
 * official login (the profile is the one already logged in, and the TUI never sees a credential),
 * the setup assistant (the automatic level, `phase7-acceptance.e2e.test.tsx`, covers it) and the
 * creation of the project, which the TUI cannot do yet: the scenario is opened by the daemon, as
 * `ot chat --type project --repo .` would. The code host is the fake one (no GitHub).
 * [N] Not run when written: nothing here reads or prints a credential, and the owner runs it.
 */

const TUI_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const run = promisify(execFile);

const PROFILE_DIR = process.env.OT_TEST_CLAUDE_PROFILE_DIR ?? '';
const MODEL = process.env.OT_TEST_CLAUDE_MODEL ?? '';
const ready =
  process.env.OT_TEST_REAL_CLIENTS === '1' &&
  process.env.OT_TEST_REAL_PROMPTS === '1' &&
  process.env.OT_TEST_REAL_PHASE7 === '1' &&
  process.platform !== 'win32' &&
  !NO_LAUNCHER &&
  PROFILE_DIR !== '' &&
  MODEL !== '' &&
  existsSync(TUI_MAIN) &&
  (await detectTmux()) !== undefined;

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const TEARDOWN_MARGIN_MS = 3 * 60_000;
const SIZE = { columns: 170, rows: 48 };
/** The delivery asks the Producer, as a person at the keys is asked (`delivery.mode: ask`). */
const EXTRA =
  'delivery:\n  mode: ask\n  allow_direct_merge: true\nchat:\n  presence: always\nui:\n  setup:\n    open: never\n';
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

// What the TUI shows in English (the pane runs with an English locale), as `tmux.smoke.test.ts`
// reads it: the texts are those of `locales/en/tui.json`.
const READY = /State: idle · Director active/;
const QUESTION_CARD = 'The Director asks you';
const MENU_CARD = 'The play needs you';
const ANY_CARD =
  /The Director asks you|The play needs you|The Director needs a decision|A group of ideas waits/;
const OPEN_PR_OPTION = /(\d)\. Open a pull request/;

function timeoutMs(): number {
  const raw = process.env.OT_TEST_PLAY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60_000) {
    throw new Error(`OT_TEST_PLAY_TIMEOUT_MS must be an integer of at least 60000, got "${raw}"`);
  }
  return value;
}

function log(text: string): void {
  // `console.log` of a passing test is hidden by vitest; stderr is not.
  process.stderr.write(`[phase7-real] ${text}\n`);
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

function recording(inner: ProcessLauncher, pids: number[]): ProcessLauncher {
  return {
    id: inner.id,
    implements: inner.implements,
    capabilities: () => inner.capabilities(),
    launch: async (options: LaunchOptions): Promise<LaunchedProcess> => {
      const process = await inner.launch(options);
      pids.push(process.pid);
      return process;
    },
  };
}

/** What a commit needs in a repository of this test: no configuration of the person reaches it. */
async function git(cwd: string, home: string, ...args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

describe.skipIf(!ready)(
  'the TUI in a real tmux with real Claude Code in the roles (OT_TEST_REAL_CLIENTS=1, OT_TEST_REAL_PROMPTS=1, OT_TEST_REAL_PHASE7=1)',
  () => {
    const limitMs = ready ? timeoutMs() : DEFAULT_TIMEOUT_MS;

    it(
      'goes from the need typed in the chat to the pull request, by keys only, and leaves no process',
      async () => {
        const home = await mkdtemp(join(tmpdir(), 'otheater-phase7-home-'));
        const profileDir = await realpath(PROFILE_DIR);
        const pids: number[] = [];
        const fakeHost = new FakeCodeHost();
        log(`client: claude-code, model: ${MODEL}`);
        const chat: ChatDaemon = await startChatDaemon(
          {
            codeHost: fakeHost,
            clock: new FakeClock(),
            vault: new InMemorySecretVault(),
            // The real client replaces the fake agent: this one is never asked for.
            client: () => [],
          },
          {
            extra: EXTRA,
            real: {
              client: 'claude-code',
              model: MODEL,
              profileDir,
              wrapLauncher: (inner) => recording(inner, pids),
            },
            prepare: async (_daemon, _dataDir, repo) => {
              // A tiny project, so the check of the need ("node --test") has something to run.
              await writeFile(join(home, 'gitconfig'), '');
              await writeFile(
                join(repo, 'package.json'),
                `${JSON.stringify({ name: 'tiny-project', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
              );
              await git(repo, home, 'add', '-A');
              await git(repo, home, 'commit', '--quiet', '-m', 'the tiny project');
              await git(repo, home, 'push', '--quiet', 'origin', 'main');
              fakeHost.seedRemote(repo, 'main');
            },
          },
        );
        const started = Date.now();
        let tmux: TmuxSession | undefined;
        let failure: unknown;
        let stopFailure: unknown;
        const answered: string[] = [];
        let screenAtEnd = '';
        try {
          tmux = await TmuxSession.start({
            command: [process.execPath, TUI_MAIN, '--data-dir', chat.dataDir],
            env: {
              HOME: home,
              USERPROFILE: home,
              XDG_CONFIG_HOME: join(home, 'config'),
              OT_CLIENT_CONFIG_DIR: join(home, 'client'),
              LANG: 'en_US.UTF-8',
              LC_ALL: 'en_US.UTF-8',
              PATH: process.env.PATH ?? '',
              TERM: PANE_TERM,
            },
            size: SIZE,
          });
          await tmux.waitFor(READY, 60_000);
          // The first frame is on the screen before the effects that listen to the keys have run.
          await new Promise((resolve) => setTimeout(resolve, 1_000));

          // The need, typed in the text box of the chat and sent with Enter.
          await tmux.type(NEED);
          await tmux.keys('Enter');
          log(`need sent at ${seconds(Date.now() - started)}`);

          // Answers what the Director asks, as a person would: the first option of each question,
          // and "Open a pull request" on the delivery card. Any other card is a limit that ran out:
          // a failure of the run, which says what it was.
          const deadline = started + limitMs;
          for (;;) {
            if (Date.now() > deadline) {
              throw new Error(
                `Timed out waiting for the play to be DONE. Screen:\n${await tmux.screen()}`,
              );
            }
            const [play] = await chat.plays();
            if (play?.state === 'DONE') break;
            if (play !== undefined && ['CANCELLED', 'FAILED'].includes(play.state)) {
              throw new Error(`The play ended ${play.state}. Screen:\n${await tmux.screen()}`);
            }
            const screen = await tmux.screen();
            if (screen.includes(MENU_CARD)) {
              const option = OPEN_PR_OPTION.exec(screen)?.[1];
              if (option === undefined) {
                throw new Error(`A menu with no "Open a pull request" option:\n${screen}`);
              }
              await tmux.keys(option);
              answered.push(`menu@${seconds(Date.now() - started)}: pull request`);
              await tmux.waitGone(MENU_CARD, 30_000);
            } else if (screen.includes(QUESTION_CARD)) {
              await tmux.keys('1');
              answered.push(`question@${seconds(Date.now() - started)}: first option`);
              try {
                await tmux.waitGone(QUESTION_CARD, 5_000);
              } catch {
                // A card of several steps or of several picks: Enter confirms what is picked.
                await tmux.keys('Enter');
                await tmux.waitGone(QUESTION_CARD, 15_000).catch(() => undefined);
              }
            } else if (ANY_CARD.test(screen)) {
              throw new Error(`A card the test does not answer:\n${screen}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }

          // The play is DONE as the TUI sees it too, and the pull request is in the fake code host.
          await tmux.waitFor('State: done', 60_000);
          const delivered = (await chat.events()).find(
            (event) => event.type === 'delivery.completed',
          );
          expect(delivered, 'delivery.completed must be in the log').toBeDefined();
          expect(delivered?.payload).toMatchObject({ mode: 'pr', requestedBy: 'producer' });
          const pulls = fakeHost.pullRequests();
          expect(pulls).toHaveLength(1);
          expect(pulls[0]).toMatchObject({ baseBranch: 'main' });
          expect(answered.some((line) => line.startsWith('menu@'))).toBe(true);
          screenAtEnd = await tmux.screen();

          // Quit by the key, as a person does: the TUI ends by itself.
          await tmux.keys('C-q');
          await tmux.waitExit(30_000);
        } catch (error) {
          failure = error;
        } finally {
          try {
            const all = await chat.events();
            const counts = new Map<string, number>();
            for (const event of all) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
            log(
              `events in the log: ${String(all.length)} (${[...counts]
                .map(([type, count]) => `${type} ${String(count)}`)
                .join(', ')})`,
            );
            for (const play of await chat.plays()) {
              const path = all
                .filter((event) => event.playId === play.id && event.type === 'play.transitioned')
                .map((event) => String((event.payload as { to?: unknown }).to))
                .join(' > ');
              log(`play ${play.id} (${play.state}): ${path}`);
            }
          } catch (error) {
            log(`the summary of the log failed: ${String(error)}`);
          }
          for (const line of answered) log(line);
          log(`pull requests in the fake code host: ${String(fakeHost.pullRequests().length)}`);
          log(`total time: ${seconds(Date.now() - started)} (deadline ${seconds(limitMs)})`);
          if (failure !== undefined && screenAtEnd === '') {
            screenAtEnd = (await tmux?.screen().catch(() => '')) ?? '';
            if (screenAtEnd !== '') log(`last screen:\n${screenAtEnd}`);
          }
          // `kill()` fails when a process of the pane outlives the tmux server.
          let paneFailure: unknown;
          try {
            await tmux?.kill();
          } catch (error) {
            paneFailure = error;
            log(`the pane left processes: ${String(error)}`);
          }
          try {
            await chat.dispose();
          } catch (error) {
            stopFailure = error;
            log(`the daemon did not stop clean: ${String(error)}`);
          }
          await rm(home, { recursive: true, force: true });
          const survivors = await waitUntil(
            'the processes of the clients to exit',
            () => Promise.resolve(pids.some(alive) ? undefined : []),
            15_000,
          ).catch(() => pids.filter(alive));
          log(`processes started: ${String(pids.length)}; left alive: ${String(survivors.length)}`);
          failure ??= paneFailure;
          if (failure === undefined && survivors.length > 0) {
            failure = new Error(
              `Processes of the clients are still alive: ${survivors.join(', ')}`,
            );
          }
          if (failure === undefined && pids.length === 0) {
            failure = new Error('No client process was started');
          }
        }
        if (stopFailure !== undefined) {
          failure ??= new Error('the daemon did not stop clean', { cause: stopFailure });
        }
        if (failure !== undefined) {
          throw failure instanceof Error
            ? failure
            : new Error('the phase 7 real run failed', { cause: failure });
        }
      },
      limitMs + TEARDOWN_MARGIN_MS,
    );
  },
);
