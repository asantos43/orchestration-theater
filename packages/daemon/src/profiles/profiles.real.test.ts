// SPDX-License-Identifier: MPL-2.0
import { constants, openSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { ReadStream } from 'node:tty';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { pathFinder, selectClients, type ClientSelection } from '../clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';

/**
 * The `profiles` level of the real acceptance (P23, architecture 5.6, N122): a SECOND profile of a
 * client, created in a temporary data directory, logged in by the official login of the client with
 * the OWNER AT THE KEYBOARD, checked, logged out and removed. Nothing here runs by default.
 *
 * - `OT_TEST_REAL_PROFILES=1` turns it on (`tools/acceptance/real-acceptance.sh --level profiles`),
 *   and `OT_TEST_PROFILES_CLIENTS` lists the clients to log in (`claude-code,codex,opencode`).
 *   There is no default list: a login is a step of the owner, so each client is asked for by name.
 * - For each client the test prints the login the client asks for (the mode, the URL and, for
 *   `device_code`, the code; both are meant to be shown to the person) and waits for the owner to
 *   finish it, up to `OT_TEST_PROFILES_LOGIN_TIMEOUT_MS` (default 10 minutes). The agent that wrote
 *   this test never logs in and never ran it.
 * - When the browser ends on a page with a code to paste (Claude Code: `Paste code here if
 *   prompted`), the owner pastes it in the terminal and presses Enter: the acceptance script reads
 *   the line from its terminal and passes it through a FIFO (`OT_TEST_PROFILES_CODE_FIFO`, P27b),
 *   and the test hands it to `LoginFlow.submitCode` (P27, N158); run by hand, the test reads
 *   `/dev/tty`. The line is never printed or logged; a login that comes back to the machine by
 *   itself never needs it.
 * - The profile lives in a temporary data directory (`profiles/<client>/second`), never in the
 *   owner's own profiles, and the daemon is pointed at that directory only. The test reads no
 *   credential file: the only thing it learns is "has a login or not", from the login probe (P2).
 * - The provider of the profile is [proposta] `anthropic` (Claude Code), `openai` (Codex) and
 *   `opencode` (OpenCode); it is a label of the registry (it decides the same-provider notice) and
 *   the login does not read it.
 *
 * The flow, per client (each step is an assertion): the profile is added and has no login yet;
 * `adapter.login` (P3) gives the flow; the owner finishes it; the login probe says `logged_in`;
 * `profiles.remove` runs the official logout (`loggedOut: true`), deletes the directory and keeps
 * the row as `removed`; no process of the client is left. [N] Not run by the agent that wrote it.
 */

const enabled = process.env.OT_TEST_REAL_PROFILES === '1' && process.platform !== 'win32';
const LOGIN_TIMEOUT_MS = Number(process.env.OT_TEST_PROFILES_LOGIN_TIMEOUT_MS ?? '') || 600_000;
const TEST_TIMEOUT_MS = LOGIN_TIMEOUT_MS + 5 * 60_000;

const PROVIDER: Readonly<Record<ClientId, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  opencode: 'opencode',
};

const CONFIG = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
`);

const wanted = (process.env.OT_TEST_PROFILES_CLIENTS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

/** The clients the owner asked for that the daemon's own search finds in PATH. */
const found: readonly ClientSelection[] = enabled
  ? selectClients(CONFIG, DEFAULT_CLIENT_EXECUTABLES, pathFinder(process.env)).filter(
      (selection) => selection.enabled && wanted.includes(selection.id),
    )
  : [];

afterAll(disposeTestGitIsolation);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lines the owner types, read once for the whole file: from the FIFO the acceptance script fills
 * from its terminal (`OT_TEST_PROFILES_CODE_FIFO`; the script runs this test under `setsid`, so the
 * test has no terminal of its own [V: ENXIO on `/dev/tty`, 2026-11-19]), else from `/dev/tty`.
 * `null` once neither opens. Nothing read is printed or logged.
 */
let typed: { input: Socket | ReadStream; lines: Interface } | null | undefined;
/** The login waiting for a pasted code, if any; a line goes to one login at most. */
let waitingLogin: ((code: string) => Promise<void>) | undefined;

function openTyped(): boolean {
  if (typed !== undefined) return typed !== null;
  const fifo = process.env.OT_TEST_PROFILES_CODE_FIFO;
  try {
    const input =
      fifo !== undefined && fifo !== ''
        ? // O_RDWR keeps the FIFO open without a writer, and O_NONBLOCK keeps the open from waiting.
          new Socket({
            fd: openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK),
            readable: true,
            writable: false,
          })
        : new ReadStream(openSync('/dev/tty', 'r'));
    const lines = createInterface({ input, terminal: false });
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      const submit = waitingLogin;
      waitingLogin = undefined;
      if (submit === undefined) {
        console.log(
          '[profiles-real] a line came while no login was waiting for a code; it was dropped',
        );
        return;
      }
      submit(line).catch((error: unknown) => {
        console.log(
          `[profiles-real] the code was not handed to the login: ${(error as Error).message}`,
        );
      });
    });
    typed = { input, lines };
  } catch {
    typed = null;
  }
  return typed !== null;
}

afterAll(() => {
  if (typed) {
    typed.lines.close();
    typed.input.destroy();
  }
});

/**
 * Hands the next line the owner types to `submit` (P27, N158). Returns a function that stops
 * waiting.
 */
function codeFromTerminal(submit: (code: string) => Promise<void>): () => void {
  if (!openTyped()) {
    console.log(
      '[profiles-real] no terminal to read a pasted code from; only a login that comes back by itself can finish',
    );
    return () => undefined;
  }
  waitingLogin = submit;
  return () => {
    if (waitingLogin === submit) waitingLogin = undefined;
  };
}

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

describe.skipIf(!enabled)(
  'real profiles: login, check, logout and remove (OT_TEST_REAL_PROFILES=1)',
  () => {
    it('has the clients the owner asked for in PATH', () => {
      expect(
        wanted,
        'set OT_TEST_PROFILES_CLIENTS to a list of claude-code, codex and opencode',
      ).not.toHaveLength(0);
      const missing = wanted.filter((name) => !found.some((selection) => selection.id === name));
      expect(missing, 'asked for, but not in PATH (or not enabled)').toEqual([]);
    });

    it.each(found.map((selection) => [selection.id] as const))(
      '%s: a second profile logs in with the owner, is checked, logs out and is removed',
      async (id) => {
        const tmp = await makeTempDataDir();
        const real = defaultLauncher();
        if (real === undefined) throw new Error('this platform has no process launcher');
        const { launcher, pids } = recording(real);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config: CONFIG,
          overrides: { vault: new InMemorySecretVault(), launcher },
          clients: productionClients(CONFIG),
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        let profileId: string | undefined;
        try {
          const execution = daemon.execution;
          if (execution === undefined) throw new Error('the daemon has no execution');
          const adapter = execution.pool.adapterOf(id);

          // 1. The profile exists and has no login yet.
          const added = await daemon.profiles.add({
            client: id,
            name: 'second',
            kind: 'token_plan',
            provider: PROVIDER[id],
          });
          if (added.status !== 'added') throw new Error(`unexpected: ${added.status}`);
          profileId = added.profile.id;
          expect(added.login, 'a new profile must not start logged in').not.toBe('logged_in');
          const profile = { client: id, profile: 'second', id: profileId, dir: added.profile.dir };

          // 2. The official login, with the owner at the keyboard (N122).
          const flow = await adapter.login(profile);
          console.log(`[profiles-real] ${id}: finish the login now (mode ${flow.mode})`);
          if (flow.url !== undefined) console.log(`[profiles-real] ${id}: open ${flow.url}`);
          if (flow.code !== undefined)
            console.log(`[profiles-real] ${id}: type the code ${flow.code}`);
          if (flow.mode === 'terminal') {
            console.log(
              `[profiles-real] ${id}: the client asks for a terminal; if nothing shows, this client cannot be logged in by this test (record it as [N])`,
            );
          }
          let stopReading = (): void => undefined;
          if (flow.submitCode !== undefined && flow.mode !== 'terminal') {
            const submit = flow.submitCode.bind(flow);
            console.log(
              `[profiles-real] ${id}: if the browser shows a code to paste, paste it here and press Enter (it goes to the client's login and is never logged)`,
            );
            stopReading = codeFromTerminal(submit);
          }
          const outcome = await Promise.race([
            flow.complete().then(() => 'done' as const),
            sleep(LOGIN_TIMEOUT_MS).then(() => 'timeout' as const),
          ]).finally(stopReading);
          if (outcome === 'timeout') {
            await flow.cancel();
            throw new Error(`${id}: the login did not finish in ${String(LOGIN_TIMEOUT_MS)} ms`);
          }

          // 3. The login probe sees it (never a credential file).
          const [listed] = await daemon.profiles.list({ client: id, checkLogin: true });
          expect(listed?.profile.id).toBe(profileId);
          expect(listed?.login, `${id}: the probe after the login`).toBe('logged_in');

          // 4. Remove: the official logout, the directory gone, the row kept as `removed`.
          const removed = await daemon.profiles.remove(profileId, { timeoutMs: 0 });
          expect(removed.loggedOut, `${id}: the official logout ran`).toBe(true);
          expect(removed.dir).toBe('deleted');
          const after = await daemon.profiles.list({ client: id, includeRemoved: true });
          expect(after.find((one) => one.profile.id === profileId)?.profile.state).toBe('removed');
          profileId = undefined;
        } finally {
          // A failure above must not leave a login behind in the temporary profile.
          if (profileId !== undefined) {
            await daemon.profiles.remove(profileId, { timeoutMs: 0 }).catch(() => undefined);
          }
          await daemon.stop();
          await tmp.dispose();
        }
        expect(pids.filter(alive), `${id}: processes left`).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
