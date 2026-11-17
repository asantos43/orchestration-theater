// SPDX-License-Identifier: MPL-2.0
import type { McpServerRef, RolePolicy } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  FRAMEWORK_MCP_NAME,
  type McpAccess,
  type McpGrant,
  type McpGrantInput,
} from '../mcp/access.js';
import { TEST_POLICY } from '../test-helpers.js';
import { makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';

/**
 * How the runner hands the framework MCP server to a session (architecture 5.3): the grant of the
 * attempt reaches the client in `mcpServers` of `session/new` AND of `session/load`, the token is
 * bound to the session once it exists, and it ends with the go. The server is a double here; the
 * real one is covered by `mcp/server.test.ts` and `mcp-submit.test.ts`.
 */

const WITH_FRAMEWORK: RolePolicy = { ...TEST_POLICY, mcpServers: [FRAMEWORK_MCP_NAME] };

interface Issued {
  readonly input: McpGrantInput;
  readonly server: McpServerRef;
  readonly bound: string[];
  revoked: number;
}

/** A `McpAccess` that numbers its tokens and remembers what happened to each. */
function doubleOf(): { access: McpAccess; issued: Issued[] } {
  const issued: Issued[] = [];
  const access: McpAccess = {
    url: 'http://127.0.0.1:1/mcp',
    grant(input: McpGrantInput): McpGrant {
      const server: McpServerRef = {
        name: FRAMEWORK_MCP_NAME,
        url: 'http://127.0.0.1:1/mcp',
        headers: { Authorization: `Bearer token-${String(issued.length + 1)}` },
      };
      const record: Issued = { input, server, bound: [], revoked: 0 };
      issued.push(record);
      return {
        role: input.role,
        attemptId: input.attemptId,
        server,
        bind: (sessionId) => record.bound.push(sessionId),
        get sessionId() {
          return record.bound.at(-1);
        },
        revoke: () => {
          record.revoked += 1;
        },
      };
    },
  };
  return { access, issued };
}

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(access: McpAccess): Promise<TestRig> {
  const made = await makeRig(fakes(), {}, access);
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});
afterAll(disposeTestGitIsolation);

const TEST_TIMEOUT_MS = 30_000;

describe('AttemptRunner, framework MCP server', () => {
  it(
    'hands the session the server with its token, binds it to the session and revokes it at the end',
    async () => {
      const { access, issued } = doubleOf();
      const r = await rig(access);
      const outcome = await r.runner.run(
        specOf(r, 'hello', { role: 'author', policy: WITH_FRAMEWORK }),
      );
      expect(outcome).toMatchObject({ state: 'completed' });

      expect(r.transport.opened).toHaveLength(1);
      expect(r.transport.opened[0]?.mcpServers).toEqual([issued[0]?.server]);
      expect(issued).toHaveLength(1);
      expect(issued[0]?.input).toMatchObject({
        attemptId: outcome.attemptId,
        role: 'author',
        correlation: { playId: 'play-1', demandId: 'demand-1', attemptId: outcome.attemptId },
      });
      expect(issued[0]?.bound).toEqual([outcome.sessionId]);
      expect(issued[0]?.revoked).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hands a new token to the session that is reloaded, and ends each token with its go',
    async () => {
      const { access, issued } = doubleOf();
      const r = await rig(access);
      const running = r.runner.run(
        specOf(r, '#script:hang', { role: 'author', policy: WITH_FRAMEWORK }),
      );
      await until(() => r.launcher.launched.length === 1, 'the first process');
      await until(() => issued[0]?.bound.length === 1, 'the first token to be bound');
      r.launcher.launched[0]?.exit(137);
      const outcome = await running;

      expect(outcome).toMatchObject({ state: 'completed', resumes: 1 });
      expect(r.transport.loaded).toHaveLength(1);
      expect(issued).toHaveLength(2);
      expect(r.transport.loaded[0]?.mcpServers).toEqual([issued[1]?.server]);
      expect(issued[1]?.server.headers).not.toEqual(issued[0]?.server.headers);
      expect(issued.map((grant) => grant.revoked)).toEqual([1, 1]);
      expect(issued[1]?.bound).toEqual([outcome.sessionId]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives no grant to an attempt without a role or whose policy does not list the server',
    async () => {
      const { access, issued } = doubleOf();
      const r = await rig(access);
      await r.runner.run(specOf(r, 'a', { role: 'author' }));
      expect(issued).toHaveLength(0);
      expect(r.transport.opened[0]?.mcpServers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'revokes the token when the session cannot be opened',
    async () => {
      const { access, issued } = doubleOf();
      const r = await rig(access);
      r.transport.failWith = new Error('boom');
      const outcome = await r.runner.run(
        specOf(r, 'a', { role: 'author', policy: WITH_FRAMEWORK }),
      );
      expect(outcome.state).not.toBe('completed');
      expect(issued.length).toBeGreaterThan(0);
      expect(issued.every((grant) => grant.revoked >= 1)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
