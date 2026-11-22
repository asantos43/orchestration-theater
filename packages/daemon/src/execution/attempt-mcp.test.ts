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
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';

/**
 * How the runner hands the framework MCP server to a session (architecture 5.3): the grant of the
 * attempt reaches the client in `mcpServers` of `session/new` AND of `session/load`, the token is
 * bound to the session once it exists, and it ends with the go. The server is a double here; the
 * real one is covered by `mcp/server.test.ts` and `mcp-submit.test.ts`.
 */

const WITH_FRAMEWORK: RolePolicy = {
  ...TEST_POLICY,
  mcpServers: [FRAMEWORK_MCP_NAME],
  mcpTools: { [FRAMEWORK_MCP_NAME]: 'all' },
};

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

function fakes(onPrepareProfile?: (policy: RolePolicy) => void) {
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
      ...(onPrepareProfile === undefined
        ? {}
        : {
            onPrepareProfile: (_profile, policy) => {
              onPrepareProfile(policy);
            },
          }),
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(
  access: McpAccess,
  onPrepareProfile?: (policy: RolePolicy) => void,
): Promise<TestRig> {
  const made = await makeRig(fakes(onPrepareProfile), {}, access);
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});
afterAll(disposeTestGitIsolation);

const TEST_TIMEOUT_MS = 30_000;

describe('AttemptRunner, an error nobody planned for (P18b)', () => {
  it('writes attempt.aborted with a masked error and marks the attempt failed', async () => {
    const key = 'sk-abcdefghijklmnopqrstuvwx';
    const access: McpAccess = {
      url: 'http://127.0.0.1:1/mcp',
      grant(): McpGrant {
        throw new Error(`the token store broke, key ${key}`);
      },
    };
    const r = await rig(access);
    await expect(
      r.runner.run(specOf(r, 'hello', { role: 'author', policy: WITH_FRAMEWORK })),
    ).rejects.toThrow('the token store broke');
    const aborted = await eventsOf(r, 'attempt.aborted');
    expect(aborted).toHaveLength(1);
    const payload = aborted[0]?.payload as { error: string };
    expect(payload).toMatchObject({ playId: 'play-1', demandId: 'demand-1' });
    expect(payload.error).toContain('the token store broke');
    expect(payload.error).not.toContain(key);
    const [record] = await r.store.attempts.list();
    expect(record).toMatchObject({ state: 'failed' });
  }, 30_000);
});

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

describe('AttemptRunner, plugin tools of the policy (P6)', () => {
  const WITH_LIST: RolePolicy = {
    ...TEST_POLICY,
    mcpServers: [FRAMEWORK_MCP_NAME],
    mcpTools: { [FRAMEWORK_MCP_NAME]: ['submit_delivery'] },
  };

  /** A double whose `pluginTools` answers `names` and remembers what it was asked. */
  function withPlugins(names: readonly string[] | Error) {
    const { access, issued } = doubleOf();
    const asked: Parameters<NonNullable<McpAccess['pluginTools']>>[0][] = [];
    const withTools: McpAccess = {
      ...access,
      pluginTools: (query) => {
        asked.push(query);
        return names instanceof Error ? Promise.reject(names) : Promise.resolve(names);
      },
    };
    return { access: withTools, issued, asked };
  }

  it(
    'puts the allowed plugin tools in the policy of the client and in the grant',
    async () => {
      const { access, issued, asked } = withPlugins(['demo__echo', 'demo__pid']);
      const prepared: RolePolicy[] = [];
      const r = await rig(access, (policy) => prepared.push(policy));
      const outcome = await r.runner.run(specOf(r, 'hello', { role: 'author', policy: WITH_LIST }));
      expect(outcome).toMatchObject({ state: 'completed' });

      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        role: 'author',
        policy: { nativeTools: TEST_POLICY.nativeTools },
      });
      expect(prepared[0]?.mcpTools[FRAMEWORK_MCP_NAME]).toEqual([
        'submit_delivery',
        'demo__echo',
        'demo__pid',
      ]);
      expect(issued[0]?.input.pluginTools).toEqual(['demo__echo', 'demo__pid']);
      // The server reads `pluginTools` first; `tools` carries the same names for a server that does not.
      expect(issued[0]?.input.tools).toEqual(['submit_delivery', 'demo__echo', 'demo__pid']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a policy with no plugin tool is left as it was, and the grant says so (an empty list)',
    async () => {
      const { access, issued } = withPlugins([]);
      const prepared: RolePolicy[] = [];
      const r = await rig(access, (policy) => prepared.push(policy));
      await r.runner.run(specOf(r, 'hello', { role: 'author', policy: WITH_LIST }));
      expect(prepared[0]?.mcpTools[FRAMEWORK_MCP_NAME]).toEqual(['submit_delivery']);
      expect(issued[0]?.input.pluginTools).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a failure of the permissions costs the plugin tools and not the session',
    async () => {
      const { access, issued } = withPlugins(new Error('the registry broke'));
      const prepared: RolePolicy[] = [];
      const r = await rig(access, (policy) => prepared.push(policy));
      const outcome = await r.runner.run(specOf(r, 'hello', { role: 'author', policy: WITH_LIST }));
      expect(outcome).toMatchObject({ state: 'completed' });
      expect(prepared[0]?.mcpTools[FRAMEWORK_MCP_NAME]).toEqual(['submit_delivery']);
      expect(issued[0]?.input.pluginTools).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not ask for plugin tools when the policy does not list the server',
    async () => {
      const { access, issued, asked } = withPlugins(['demo__echo']);
      const r = await rig(access);
      await r.runner.run(specOf(r, 'hello', { role: 'author' }));
      expect(asked).toHaveLength(0);
      expect(issued).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a server that does not know plugin tools gets the grant it always got',
    async () => {
      const { access, issued } = doubleOf();
      const r = await rig(access);
      await r.runner.run(specOf(r, 'hello', { role: 'author', policy: WITH_LIST }));
      expect(issued[0]?.input.pluginTools).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
