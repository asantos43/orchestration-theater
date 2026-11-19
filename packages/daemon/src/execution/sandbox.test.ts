// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_POLICY_FIELDS,
  type Enforcement,
  type EventEnvelope,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLauncher, probeSandbox, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import type { AttemptSpec } from './attempt-runner.js';

/**
 * Layer 3 end to end (architecture 5.8): the fake agent over the REAL ACP stdio transport runs
 * INSIDE the sandbox of the daemon (bubblewrap on Linux) and tries what the operating system must
 * refuse. The checks are the answers of the system to the process of the agent (`EACCES`,
 * `EROFS`, `ECONNREFUSED`...), not a rule of the daemon. The config has NO `security.unenforced:
 * warn`: the sessions start only because `guarantee()` counts the sandbox as the layer of
 * `writeScope` and `network`.
 *
 * The secret here is a fake `.ssh` folder in a temporary directory, listed in
 * `security.secret_paths.add`; the test never reads a real secret. Only a local HTTP server on
 * 127.0.0.1 is used as the "outside" of the network. The client is the compiled `dist/cli.js`, so
 * `pnpm build` comes first. Without a working sandbox the tests are skipped, unless
 * `OT_REQUIRE_SANDBOX=1` (the CI sets it), which turns the absence into a failure.
 */

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const POLICY: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/**
 * A client like the real ones as to the OS fields: it guarantees by itself everything but where it
 * writes and where it connects, which only layer 3 can (`security.min_layers` asks for one layer).
 */
const ENFORCEMENT = Object.fromEntries(
  ROLE_POLICY_FIELDS.map((field) => [
    field,
    field === 'writeScope' || field === 'network' ? [] : ['client'],
  ]),
) as unknown as Enforcement;

let sandboxIssue: string | undefined;

beforeAll(async () => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
  const availability = await probeSandbox();
  if (!availability.ok) {
    sandboxIssue = availability.reason;
    if (process.env.OT_REQUIRE_SANDBOX === '1') {
      throw new Error(
        `OT_REQUIRE_SANDBOX=1 but the sandbox is not available: ${availability.reason}`,
      );
    }
  }
});
afterAll(disposeTestGitIsolation);

function chunksOf(events: readonly EventEnvelope[], attemptId: string): string {
  return events
    .filter((event) => event.attemptId === attemptId && event.type === 'session.update')
    .map((event) => JSON.stringify(event.payload))
    .join('\n');
}

interface Outside {
  /** A temporary home with a fake `.ssh/id_fake` (listed as a secret path). */
  readonly sshDir: string;
  readonly secretFile: string;
  /** A folder outside the worktree where a write must fail. */
  readonly outsideDir: string;
  /** The port of a server on the host's loopback and the number of requests it saw. */
  readonly port: number;
  readonly requests: () => number;
}

async function withOutside(body: (outside: Outside) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'otheater-sandbox-it-')));
  const sshDir = join(base, 'home', '.ssh');
  await mkdir(sshDir, { recursive: true });
  const secretFile = join(sshDir, 'id_fake');
  await writeFile(secretFile, 'not a real key\n');
  const outsideDir = join(base, 'outside');
  await mkdir(outsideDir);
  let seen = 0;
  const server: Server = createServer((_request, response) => {
    seen += 1;
    response.end('hello from the host\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await body({ sshDir, secretFile, outsideDir, port, requests: () => seen });
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(base, { recursive: true, force: true });
  }
}

async function withDaemon(
  outside: Outside,
  body: (daemon: DaemonHandle, repo: string, profile: Profile) => Promise<void>,
  extraConfig = '',
): Promise<void> {
  const tmp = await makeTempDataDir();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  // NO `security.unenforced: warn`: layer 3 is what makes `writeScope` and `network` hold.
  const config = parseConfig(`
backup:
  when: manual
security:
  secret_paths:
    add:
      - ${JSON.stringify(outside.sshDir)}
${extraConfig}`);
  const profileDir = join(tmp.dir, 'profiles', 'fake', 'one');
  await mkdir(profileDir, { recursive: true });
  const profile: Profile = { client: 'fake', profile: 'one', id: 'fake/one', dir: profileDir };
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config,
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault(), launcher: real },
    clients: (parts) => [
      ...productionClients(config)(parts),
      new FakeClientAdapter({
        launcher: parts.launcher,
        baseEnv: {},
        adapterVersion: '1.0.0',
        enforcement: ENFORCEMENT,
        command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
        ...(parts.sandbox === undefined
          ? {}
          : { sandbox: parts.sandbox.capabilities, launchWrapper: parts.sandbox.launchWrapper }),
      }),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  const { repo, dispose } = await makeRepo();
  // A tracked `.env` (a fake one): the worktree of the attempt is a checkout of it. The library
  // hides the files that exist when the command starts, so a `.env` that the agent creates later
  // is not covered on Linux [V, measured here]; that is the reason to commit it first.
  await writeFile(join(repo, '.env'), 'FAKE_TOKEN=1\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'add a fake .env');
  try {
    await body(daemon, repo, profile);
  } finally {
    await dispose();
    await daemon.stop();
    await tmp.dispose();
  }
}

function specOf(repo: string, profile: Profile, demandId: string, prompt: string): AttemptSpec {
  return {
    playId: 'play-sandbox',
    demandId,
    attempt: 1,
    repo,
    base: 'main',
    profile,
    executor: { model: 'fake-model' },
    policy: POLICY,
    prompt,
    role: 'author',
  };
}

describe('the fake agent inside the sandbox of the daemon', () => {
  it('writes in its worktree and in nothing else, reads nothing secret and reaches nothing outside', async (context) => {
    if (sandboxIssue !== undefined) {
      context.skip();
      return;
    }
    await withOutside(async (outside) => {
      await withDaemon(outside, async (daemon, repo, profile) => {
        const runner = daemon.execution?.runner;
        if (runner === undefined) throw new Error('the daemon has no execution');
        const outsideFile = join(outside.outsideDir, 'escaped.txt');
        const probe = {
          // Relative paths are the worktree (the cwd of the agent).
          write: ['inside.txt', outsideFile],
          read: ['inside.txt', '.env', outside.secretFile],
          connect: [`127.0.0.1:${String(outside.port)}`],
        };
        const result = await runner.run(
          specOf(repo, profile, 'probe', `#script:probe ${JSON.stringify(probe)}\nprobe`),
        );
        // `guarantee()` passed with no `unenforced: warn`: the session ran and ended its turn.
        expect(result).toMatchObject({ state: 'completed', stopReason: 'end_turn' });

        const events = await daemon.store.events.readFrom(0, 100_000);
        const text = chunksOf(events, result.attemptId);

        // Writes: the worktree yes, the outside no.
        expect(text).toContain('probe write inside.txt: ok');
        expect(text).toMatch(/probe write [^"]*escaped\.txt: failed (EROFS|EACCES|EPERM|ENOENT)/);
        expect(existsSync(outsideFile)).toBe(false);

        // Reads: a file of the worktree yes; its `.env` (the worktree lies under `<data>`, a secret
        // path itself) and the secret path no.
        expect(text).toContain('probe read inside.txt: ok');
        expect(text).toMatch(/probe read \.env: failed (EACCES|EPERM|ENOENT)/);
        expect(text).toMatch(/probe read [^"]*id_fake: failed (EACCES|EPERM|ENOENT)/);

        // Network: a raw connection to the host's loopback does not get out (own loopback, no
        // route), and the server of the host never saw a request.
        expect(text).toMatch(
          /probe connect 127\.0\.0\.1:\d+: failed (ECONNREFUSED|ENETUNREACH|EPERM)/,
        );
        expect(outside.requests()).toBe(0);
      });
    });
  }, 90_000);

  it('refuses the same session when the sandbox is off and security.unenforced is not warn', async () => {
    await withOutside(async (outside) => {
      await withDaemon(
        outside,
        async (daemon, repo, profile) => {
          const runner = daemon.execution?.runner;
          if (runner === undefined) throw new Error('the daemon has no execution');
          // The contrast of the first test: no layer 3, so `writeScope` and `network` have no
          // guarantee and the default (`security.unenforced: refuse`) stops the session.
          const result = await runner.run(specOf(repo, profile, 'off', '#script:echo\nnever runs'));
          expect(result).toMatchObject({ state: 'interrupted', cause: 'permission' });
          const events = await daemon.store.events.readFrom(0, 100_000);
          expect(chunksOf(events, result.attemptId)).not.toContain('never runs');
        },
        'sandbox:\n  mode: off\n',
      );
    });
  }, 90_000);
});

/**
 * N115: the framework MCP server listens on the loopback of the host, and a client inside the
 * sandbox has a loopback of its own. The fake agent calls the tool with `fetch` (which ignores the
 * proxy and obeys nothing but the address), so only a listener inside the sandbox on the same port
 * lets the call arrive. Linux only: Seatbelt (macOS) was not measured.
 */
describe('the framework MCP server from inside the sandbox (N115)', () => {
  const WITH_MCP: RolePolicy = {
    ...POLICY,
    mcpServers: ['otheater'],
    mcpTools: { otheater: 'all' },
  };
  const SUBMIT =
    '#script:submit {"tool":"submit_plan","output":{"plan":"do a, then b","openQuestions":[]}}\nsubmit';
  const onLinux = process.platform === 'linux';

  async function submitted(
    extraConfig: string,
    context: { skip: () => void },
  ): Promise<{ submitted: number; text: string; failures: number } | undefined> {
    if (sandboxIssue !== undefined || !onLinux) {
      context.skip();
      return undefined;
    }
    let outcome: { submitted: number; text: string; failures: number } | undefined;
    await withOutside(async (outside) => {
      await withDaemon(
        outside,
        async (daemon, repo, profile) => {
          const runner = daemon.execution?.runner;
          if (runner === undefined) throw new Error('the daemon has no execution');
          expect(daemon.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
          const result = await runner.run({
            ...specOf(repo, profile, 'mcp-bridge', SUBMIT),
            policy: WITH_MCP,
          });
          const events = (await daemon.store.events.readFrom(0, 100_000)).filter(
            (event) => event.attemptId === result.attemptId,
          );
          outcome = {
            submitted: events.filter((event) => event.type === 'attempt.submitted').length,
            failures: events.filter((event) => event.type === 'attempt.submit_failed').length,
            text: chunksOf(events, result.attemptId),
          };
        },
        extraConfig,
      );
    });
    return outcome;
  }

  it('reaches the tool of the daemon at the same URL and the daemon records the submit', async (context) => {
    const outcome = await submitted('', context);
    if (outcome === undefined) return;
    expect(outcome.submitted).toBe(1);
    expect(outcome.text).toContain('submit 1');
  }, 90_000);

  it('with sandbox.mcp_bridge: off the same call never arrives (the behaviour before N115)', async (context) => {
    const outcome = await submitted('sandbox:\n  mcp_bridge: off\n', context);
    if (outcome === undefined) return;
    expect(outcome.text).not.toContain('submit 1');
    expect(outcome.submitted).toBe(0);
    expect(outcome.failures).toBe(0);
  }, 90_000);
});
