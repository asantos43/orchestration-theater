// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from './errors.js';
import { SharedProcessRegistry, sharedProcessKey } from './shared-process.js';
import { FakeProcessLauncher } from './testing/index.js';

const profile = { id: 'fake/p', dir: '/profiles/p' };
const spec = { cmd: 'client', args: ['--acp'], cwd: '/work', env: { A: '1', B: '2' } };

describe('sharedProcessKey', () => {
  it('ignores the order of the environment and the working directory', () => {
    const reordered = { ...spec, cwd: '/other', env: { B: '2', A: '1' } };
    expect(sharedProcessKey(profile, reordered)).toBe(sharedProcessKey(profile, spec));
  });

  it('changes with the profile, the command, the arguments and any environment value', () => {
    const base = sharedProcessKey(profile, spec);
    expect(sharedProcessKey({ ...profile, id: 'fake/q' }, spec)).not.toBe(base);
    expect(sharedProcessKey(profile, { ...spec, cmd: 'other' })).not.toBe(base);
    expect(sharedProcessKey(profile, { ...spec, args: [] })).not.toBe(base);
    expect(sharedProcessKey(profile, { ...spec, env: { ...spec.env, B: '3' } })).not.toBe(base);
    expect(sharedProcessKey(profile, { ...spec, env: { A: '1' } })).not.toBe(base);
  });
});

describe('SharedProcessRegistry', () => {
  it('counts concurrent leases before the launch ends, and launches once', async () => {
    const launcher = new FakeProcessLauncher();
    const registry = new SharedProcessRegistry(launcher, 3);
    const leases = await Promise.all([
      registry.acquire('k', spec),
      registry.acquire('k', spec),
      registry.acquire('k', spec),
      registry.acquire('k', spec),
    ]);
    expect(launcher.launched).toHaveLength(2);
    expect(registry.processes).toBe(2);
    for (const lease of leases) await lease.killTree();
    expect(launcher.running).toEqual([]);
    expect(registry.processes).toBe(0);
  });

  it('gives the real report to the last lease and an empty one to the others, once each', async () => {
    const launcher = new FakeProcessLauncher();
    const registry = new SharedProcessRegistry(launcher);
    const a = await registry.acquire('k', spec);
    const b = await registry.acquire('k', spec);
    expect(a.pid).toBe(b.pid);
    expect(a.stdin).toBe(b.stdin);
    await expect(a.killTree()).resolves.toEqual({ found: 0, forced: false, remaining: [] });
    await a.killTree();
    expect(launcher.launched[0]?.killTreeCalls).toBe(0);
    const last = await b.killTree();
    expect(last.found).toBe(1);
    await b.killTree();
    expect(launcher.launched[0]?.killTreeCalls).toBe(1);
  });

  it('a process that died is not joined, and an own lease is never joined', async () => {
    const launcher = new FakeProcessLauncher();
    const registry = new SharedProcessRegistry(launcher);
    const first = await registry.acquire('k', spec);
    launcher.launched[0]?.exit(1);
    await first.exited;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await registry.acquire('k', spec);
    expect(launcher.launched).toHaveLength(2);
    const own = await registry.acquire('k', spec, 'own');
    const joined = await registry.acquire('k', spec);
    expect(launcher.launched).toHaveLength(3);
    expect(joined.pid).toBe(second.pid);
    for (const lease of [second, own, joined]) await lease.killTree();
    expect(launcher.running).toEqual([]);
  });

  it('a failed launch rejects every waiting lease and leaves nothing', async () => {
    const launcher = new FakeProcessLauncher();
    launcher.failWith = new Error('ENOENT');
    const registry = new SharedProcessRegistry(launcher);
    const results = await Promise.allSettled([
      registry.acquire('k', spec),
      registry.acquire('k', spec),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(registry.processes).toBe(0);
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => new SharedProcessRegistry(new FakeProcessLauncher(), 0)).toThrow(InvalidInput);
  });
});
