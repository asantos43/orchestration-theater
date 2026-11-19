// SPDX-License-Identifier: MPL-2.0
import { assemblePrefix, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { ToolHandlers } from '../mcp/index.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';

/**
 * The acceptance of the orders (architecture 5.17, section 10) on a real daemon with a real
 * store: the orders reach the prefix of a session, survive a restart, wait for their start, and
 * stay out of the sessions opened after an end that came while the daemon was stopped.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const CONFIG = parseConfig('backup:\n  when: manual\n');

function start(dataDir: string, clock: FakeClock, handlers?: ToolHandlers): Promise<DaemonHandle> {
  return startDaemon({
    dataDir,
    clientSearch: NO_CLIENTS,
    config: CONFIG,
    overrides: { clock, vault: new InMemorySecretVault() },
    ...(handlers === undefined ? {} : { mcpHandlers: handlers }),
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
}

async function directiveEvents(daemon: DaemonHandle, type: string): Promise<EventEnvelope[]> {
  return (await daemon.store.events.readFrom(0, 1000)).filter((e) => e.type === type);
}

async function prefixFor(
  daemon: DaemonHandle,
  scenarioId: string,
  role = 'actor',
): Promise<string> {
  return assemblePrefix({
    role,
    rolePrompt: 'You are the Actor.',
    tools: daemon.registries.tools.list(),
    directives: await daemon.directives.inForce(scenarioId, role),
  });
}

describe('the orders on a running daemon', () => {
  it('a global and a local order reach the prompt and survive a restart', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const first = await start(tmp.dir, clock);
      await first.directives.create({ text: 'Always run the linter.', scope: 'global' });
      await first.directives.create({
        text: 'This project uses pnpm.',
        scope: 'local',
        scenarioId: 's1',
      });
      expect(await prefixFor(first, 's1')).toContain('Always run the linter.');
      await first.stop();

      const second = await start(tmp.dir, clock);
      const prefix = await prefixFor(second, 's1');
      expect(prefix).toContain('Always run the linter.');
      expect(prefix).toContain('This project uses pnpm.');
      // The local order is not in another scenario's prompt.
      expect(await prefixFor(second, 's2')).not.toContain('This project uses pnpm.');
      await second.stop();
    } finally {
      await tmp.dispose();
    }
  });

  // Days of a fake clock: every lap of the daemon loops in the window runs, about 1 s on Linux and
  // past the default 5 s on the Windows runner of the CI.
  it('an order with a future start only enters after the start', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const daemon = await start(tmp.dir, clock);
      await daemon.directives.create({
        text: 'Code freeze.',
        scope: 'global',
        validity: { from: '2026-11-19 09:00' },
      });
      expect(await prefixFor(daemon, 's1')).not.toContain('Code freeze.');
      await clock.advance(2 * DAY);
      expect(await prefixFor(daemon, 's1')).toContain('Code freeze.');
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  }, 30_000);

  it('an order that ends while the daemon is stopped stays out of the sessions opened after the restart', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const first = await start(tmp.dir, clock);
      const order = await first.directives.create({
        text: 'Only for this afternoon.',
        scope: 'global',
        validity: { for: '3h' },
      });
      await first.directives.create({ text: 'Stays.', scope: 'global' });
      expect(await prefixFor(first, 's1')).toContain('Only for this afternoon.');
      await first.stop();

      await clock.advance(DAY);
      const second = await start(tmp.dir, clock);
      const prefix = await prefixFor(second, 's1');
      expect(prefix).not.toContain('Only for this afternoon.');
      expect(prefix).toContain('Stays.');
      // The catch-up of the start-up wrote the end, with the real boundary and not "now".
      const expired = await directiveEvents(second, 'directive.expired');
      expect(expired).toHaveLength(1);
      expect(expired[0]?.payload).toEqual({ directiveId: order.id, effectiveAt: T0 + 3 * HOUR });
      expect(expired[0]?.timestamp).toBe(T0 + DAY);
      await second.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('a suspension takes the global order out of one scenario, in the prompt', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const daemon = await start(tmp.dir, clock);
      const global = await daemon.directives.create({ text: 'Run e2e tests.', scope: 'global' });
      await daemon.directives.create({
        text: 'Not for the docs project.',
        scope: 'local',
        scenarioId: 'docs',
        kind: 'suspension',
        suspendsId: global.id,
      });
      expect(await prefixFor(daemon, 'docs')).not.toContain('Run e2e tests.');
      expect(await prefixFor(daemon, 'app')).toContain('Run e2e tests.');
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('a revoked rule gives the configured value back, also after a restart', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const first = await start(tmp.dir, clock);
      const rule = await first.directives.create({
        text: 'Deliver by pull request.',
        scope: 'global',
        kind: 'rule',
        ruleKey: 'delivery.mode',
        ruleValue: 'pr',
      });
      expect(await first.directives.rule('delivery.mode', 'direct_merge', 's1')).toBe('pr');
      await first.stop();

      const second = await start(tmp.dir, clock);
      expect(await second.directives.rule('delivery.mode', 'direct_merge', 's1')).toBe('pr');
      await second.directives.revoke(rule.id, 'Back to the default.');
      expect(await second.directives.rule('delivery.mode', 'direct_merge', 's1')).toBe(
        'direct_merge',
      );
      await second.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('registers the tools of the Director, and leaves alone a handler the caller brought', async () => {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(T0);
    try {
      const own = new ToolHandlers().register('propose_directive', () => ({ own: true }));
      const daemon = await start(tmp.dir, clock, own);
      expect(own.has('propose_directive')).toBe(true);
      expect(own.has('list_directives')).toBe(false);
      await daemon.stop();

      const plain = new ToolHandlers();
      const other = await start(tmp.dir, clock, plain);
      for (const tool of [
        'list_directives',
        'propose_directive',
        'extend_directive',
        'revoke_directive',
      ]) {
        expect(plain.has(tool)).toBe(true);
      }
      await other.stop();
    } finally {
      await tmp.dispose();
    }
  });
});
