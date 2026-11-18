// SPDX-License-Identifier: MPL-2.0
import type { LaunchOptions, Profile, RolePolicy, Sandbox, SandboxRequest } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import {
  buildSandboxWiring,
  loopbackPort,
  loopbackRule,
  PROVIDER_DOMAINS,
} from './sandbox-wiring.js';

/** Records what it is asked to wrap and hands the launch back marked. */
class RecordingSandbox implements Sandbox {
  readonly id = 'recording';
  readonly implements = { port: 'Sandbox', range: '^0.1.0' };
  readonly requests: SandboxRequest[] = [];
  closed = 0;

  capabilities(): { fields: ['writeScope', 'network'] } {
    return { fields: ['writeScope', 'network'] };
  }
  available(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }
  wrap(request: SandboxRequest): Promise<LaunchOptions> {
    this.requests.push(request);
    return Promise.resolve({ ...request.launch, cmd: 'wrapped', args: [request.launch.cmd] });
  }
  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

const POLICY: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: ['api.example.com'] },
};

const PROFILE: Profile = {
  client: 'codex',
  profile: 'a',
  id: 'codex/a',
  dir: '/data/profiles/codex/a',
};
const LAUNCH: LaunchOptions = {
  cmd: 'codex-acp',
  args: [],
  cwd: '/data/worktrees/w1',
  env: { A: '1' },
};

describe('loopbackRule', () => {
  it('names the loopback servers as localhost:<port> and nothing else', () => {
    expect(loopbackRule('http://127.0.0.1:4321/mcp')).toBe('localhost:4321');
    expect(loopbackRule('http://localhost:9/x')).toBe('localhost:9');
    expect(loopbackRule('http://[::1]:7/')).toBe('localhost:7');
    expect(loopbackRule('http://localhost/')).toBe('localhost:80');
    expect(loopbackRule('https://localhost/')).toBe('localhost:443');
    expect(loopbackRule('https://api.example.com/')).toBeUndefined();
    expect(loopbackRule('not a url')).toBeUndefined();
  });
});

describe('loopbackPort', () => {
  it('is the port of a loopback URL, with the default of the scheme, and nothing else', () => {
    expect(loopbackPort('http://127.0.0.1:4321/mcp')).toBe(4321);
    expect(loopbackPort('http://localhost/')).toBe(80);
    expect(loopbackPort('https://[::1]/')).toBe(443);
    expect(loopbackPort('https://api.example.com/')).toBeUndefined();
    expect(loopbackPort('nope')).toBeUndefined();
  });
});

describe('buildSandboxWiring', () => {
  const config = parseConfig(
    'sandbox:\n  extra_write_paths: [/var/cache/x]\n  extra_domains: [registry.npmjs.org]\nsecurity:\n  secret_paths:\n    add: ["~/.vault"]\n',
  );

  function wiring(sandbox: Sandbox = new RecordingSandbox()) {
    return buildSandboxWiring({ sandbox, config, home: '/home/u', dataDir: '/data' });
  }

  it('offers what the sandbox guarantees, for guarantee()', () => {
    expect(wiring().capabilities).toEqual({ fields: ['writeScope', 'network'] });
  });

  it('confines a client to its worktree and profile, with the domains of its provider, the config and the daemon', async () => {
    const sandbox = new RecordingSandbox();
    const launch = await wiring(sandbox).launchWrapper(() => ['http://127.0.0.1:4321/mcp'])({
      profile: PROFILE,
      policy: POLICY,
      cwd: '/data/worktrees/w1',
      via: 'acp',
      spec: LAUNCH,
    });
    expect(launch.cmd).toBe('wrapped');
    const [request] = sandbox.requests;
    expect(request).toMatchObject({
      launch: LAUNCH,
      policy: POLICY,
      worktree: '/data/worktrees/w1',
      profileDirs: ['/data/profiles/codex/a'],
      extraWritePaths: ['/var/cache/x'],
    });
    expect(request?.domains).toEqual([
      ...PROVIDER_DOMAINS.codex,
      'registry.npmjs.org',
      'localhost:4321',
    ]);
    // The defaults (5.19) and the added one, with `~` and `<data>` resolved.
    expect(request?.secretPaths).toContain('/home/u/.ssh');
    expect(request?.secretPaths).toContain('/home/u/.vault');
    expect(request?.secretPaths).toContain('/data');
    expect(request?.secretPaths).toContain('.env');
  });

  it('asks for the bridge of the loopback servers (N115), and not with sandbox.mcp_bridge: off', async () => {
    const run = async (yaml: string): Promise<SandboxRequest | undefined> => {
      const sandbox = new RecordingSandbox();
      await buildSandboxWiring({
        sandbox,
        config: parseConfig(yaml),
        home: '/home/u',
        dataDir: '/data',
      }).launchWrapper(() => ['http://127.0.0.1:4321/mcp', 'https://elsewhere.example/x'])({
        profile: PROFILE,
        policy: POLICY,
        cwd: '/data/worktrees/w1',
        via: 'acp',
        spec: LAUNCH,
      });
      return sandbox.requests[0];
    };
    expect((await run(''))?.loopbackPorts).toEqual([4321]);
    expect((await run('sandbox:\n  mcp_bridge: off\n'))?.loopbackPorts).toBeUndefined();
    // The domain rule stays in both modes: `off` is the behaviour before N115.
    expect((await run('sandbox:\n  mcp_bridge: off\n'))?.domains).toContain('localhost:4321');
  });

  it('gives a client nothing from the daemon when there is no loopback server', async () => {
    const sandbox = new RecordingSandbox();
    await wiring(sandbox).launchWrapper()({
      profile: { ...PROFILE, client: 'unknown' },
      policy: POLICY,
      cwd: '/data/worktrees/w1',
      via: 'acp',
      spec: LAUNCH,
    });
    expect(sandbox.requests[0]?.domains).toEqual(['registry.npmjs.org']);
    expect(sandbox.requests[0]?.loopbackPorts).toBeUndefined();
  });

  it('confines a command of the tools: its worktree, no role network, only the extra domains', async () => {
    const sandbox = new RecordingSandbox();
    await wiring(sandbox).confineCommand(LAUNCH, '/data/worktrees/w2');
    expect(sandbox.requests[0]).toMatchObject({
      worktree: '/data/worktrees/w2',
      profileDirs: [],
      extraWritePaths: ['/var/cache/x'],
      domains: ['registry.npmjs.org'],
      policy: { writeScope: 'worktree', network: { allow: [] } },
    });
    expect(sandbox.requests[0]?.loopbackPorts).toBeUndefined();
  });

  it('closes the sandbox', async () => {
    const sandbox = new RecordingSandbox();
    await wiring(sandbox).close();
    expect(sandbox.closed).toBe(1);
  });
});
