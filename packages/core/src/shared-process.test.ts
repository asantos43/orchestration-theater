// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from './errors.js';
import {
  endsSharedProcess,
  SHARED_CANCEL_MODES,
  SharedProcessRegistry,
  sharedProcessKey,
  type SharedCancelEscalation,
  type SharedCancelMode,
} from './shared-process.js';
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

describe('endsSharedProcess', () => {
  it('is never true for a plain close, whatever the mode', () => {
    for (const mode of SHARED_CANCEL_MODES) expect(endsSharedProcess(mode, undefined)).toBe(false);
  });

  it('follows the mode for a cancel', () => {
    expect(endsSharedProcess('escalate', 'honored')).toBe(false);
    expect(endsSharedProcess('escalate', 'ignored')).toBe(true);
    expect(endsSharedProcess('always_kill', 'honored')).toBe(true);
    expect(endsSharedProcess('always_kill', 'ignored')).toBe(true);
    expect(endsSharedProcess('release', 'honored')).toBe(false);
    expect(endsSharedProcess('release', 'ignored')).toBe(false);
  });
});

describe('SharedProcessRegistry, cancel of a lease', () => {
  async function pair(sharedCancel?: SharedCancelMode) {
    const launcher = new FakeProcessLauncher();
    const told: SharedCancelEscalation[] = [];
    const registry = new SharedProcessRegistry(launcher, 4, {
      ...(sharedCancel === undefined ? {} : { sharedCancel }),
      onEscalation: (escalation) => told.push(escalation),
    });
    const a = await registry.acquire('k', spec);
    const b = await registry.acquire('k', spec);
    const c = await registry.acquire('k', spec);
    return { launcher, registry, told, a, b, c };
  }

  it('escalate (default): a cancel the client honoured only gives the lease back', async () => {
    const { launcher, told, a } = await pair();
    await expect(a.killTree({ cancel: 'honored' })).resolves.toMatchObject({ found: 0 });
    expect(launcher.running).toHaveLength(1);
    expect(told).toEqual([]);
  });

  it('escalate: a cancel the client ignored kills the process and tells how many sessions fell', async () => {
    const { launcher, registry, told, a, b, c } = await pair();
    const report = await a.killTree({ cancel: 'ignored' });
    expect(report.found).toBe(1);
    expect(launcher.running).toHaveLength(0);
    expect(told).toEqual([{ pid: launcher.launched[0]?.pid, siblings: 2 }]);
    expect(registry.processes).toBe(0);
    await b.exited;
    // The sessions that fell give their leases back later; nothing is told twice.
    await b.killTree();
    await c.killTree({ cancel: 'ignored' });
    expect(told).toHaveLength(1);
    // A new session does not join the dead process.
    await registry.acquire('k', spec);
    expect(launcher.launched).toHaveLength(2);
  });

  it('escalate: the last session to leave by a cancel is a plain end, not an escalation', async () => {
    const launcher = new FakeProcessLauncher();
    const told: SharedCancelEscalation[] = [];
    const registry = new SharedProcessRegistry(launcher, 4, { onEscalation: (e) => told.push(e) });
    const only = await registry.acquire('k', spec);
    await only.killTree({ cancel: 'ignored' });
    expect(launcher.running).toHaveLength(0);
    expect(told).toEqual([]);
  });

  it('always_kill: even a honoured cancel kills the process', async () => {
    const { launcher, told, a } = await pair('always_kill');
    await a.killTree({ cancel: 'honored' });
    expect(launcher.running).toHaveLength(0);
    expect(told).toHaveLength(1);
  });

  it('always_kill and escalate: a plain close never ends the others', async () => {
    for (const mode of ['always_kill', 'escalate'] as const) {
      const { launcher, a } = await pair(mode);
      await a.killTree();
      expect(launcher.running).toHaveLength(1);
    }
  });

  it('release: a cancel only gives the lease back, ignored or not', async () => {
    const { launcher, told, a, b } = await pair('release');
    await a.killTree({ cancel: 'ignored' });
    await b.killTree({ cancel: 'honored' });
    expect(launcher.running).toHaveLength(1);
    expect(told).toEqual([]);
  });

  it('a hook that throws does not break the cancel', async () => {
    const launcher = new FakeProcessLauncher();
    const registry = new SharedProcessRegistry(launcher, 4, {
      onEscalation: () => {
        throw new Error('hook');
      },
    });
    const a = await registry.acquire('k', spec);
    await registry.acquire('k', spec);
    await expect(a.killTree({ cancel: 'ignored' })).resolves.toMatchObject({ found: 1 });
  });
});
