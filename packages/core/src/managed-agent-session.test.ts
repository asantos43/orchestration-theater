// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  PermissionDenied,
  QuotaExhausted,
  Transient,
} from './errors.js';
import {
  ManagedAgentSession,
  typedErrorOf,
  type SessionDriver,
  type SessionWarning,
} from './managed-agent-session.js';
import type { StopReason } from './normalized-update.js';
import type {
  NormalizedError,
  SessionConfigOption,
  SessionNormalizer,
} from './ports/agent-session.js';
import type { KillOptions } from './ports/process-launcher.js';
import { FakeLaunchedProcess } from './testing/fake-process-launcher.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

const normalizer: SessionNormalizer = {
  normalizeUpdate: (raw) =>
    typeof raw === 'string'
      ? { kind: 'agent_message_chunk', content: { type: 'text', text: raw } }
      : null,
  normalizeError: (raw): NormalizedError => {
    const message = raw instanceof Error ? raw.message : String(raw);
    return message === 'quota'
      ? { kind: 'quota_exhausted', message }
      : { kind: 'unknown', message };
  },
};

class ScriptedDriver implements SessionDriver {
  turns: { resolve: (reason: StopReason) => void; reject: (error: unknown) => void }[] = [];
  cancels = 0;
  disconnects = 0;
  configs: [string, unknown][] = [];
  failConfig: Error | undefined;
  announce: readonly SessionConfigOption[] | undefined;
  runTurn(): Promise<StopReason> {
    return new Promise((resolve, reject) => {
      this.turns.push({ resolve, reject });
    });
  }
  requestCancel(): Promise<void> {
    this.cancels += 1;
    return Promise.resolve();
  }
  applyConfig(id: string, value: unknown): Promise<readonly SessionConfigOption[] | undefined> {
    this.configs.push([id, value]);
    return this.failConfig === undefined
      ? Promise.resolve(this.announce)
      : Promise.reject(this.failConfig);
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

function setup(options: { cancelGraceMs?: number; onWarning?: (w: SessionWarning) => void } = {}) {
  const driver = new ScriptedDriver();
  const process = new FakeLaunchedProcess(1, { cmd: 'x', args: [], cwd: '/', env: {} });
  const session = new ManagedAgentSession({
    sessionId: 's1',
    canLoad: true,
    driver,
    process,
    normalizer,
    cancelGraceMs: 20,
    ...options,
  });
  return { driver, process, session };
}

describe('ManagedAgentSession', () => {
  it('resolves the prompt with the stop reason after the updates reached the listeners', async () => {
    const { driver, session } = setup();
    const seen: string[] = [];
    session.onUpdate((update) => {
      if (update.kind === 'agent_message_chunk' && update.content.type === 'text') {
        seen.push(update.content.text);
      }
    });
    const turn = session.prompt(text('hi'));
    session.deliver('a');
    session.deliver('b');
    driver.turns[0]?.resolve('end_turn');
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
    expect(seen).toEqual(['a', 'b']);
  });

  it('swallows what the normalizer swallows and what makes it throw', () => {
    const warnings: SessionWarning[] = [];
    const { session } = setup({ onWarning: (w) => warnings.push(w) });
    const seen: unknown[] = [];
    session.onUpdate((update) => seen.push(update));
    session.deliver({ not: 'a string' });
    expect(seen).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps going when a listener throws, and tells the hook', () => {
    const warnings: SessionWarning[] = [];
    const { session } = setup({ onWarning: (w) => warnings.push(w) });
    const seen: unknown[] = [];
    session.onUpdate(() => {
      throw new Error('boom');
    });
    session.onUpdate((update) => seen.push(update));
    session.deliver('a');
    expect(seen).toHaveLength(1);
    expect(warnings.map((w) => w.kind)).toEqual(['listener_threw']);
  });

  it('stops delivering to a listener once it is disposed', () => {
    const { session } = setup();
    const seen: unknown[] = [];
    const handle = session.onUpdate((update) => seen.push(update));
    session.deliver('a');
    handle.dispose();
    handle.dispose();
    session.deliver('b');
    expect(seen).toHaveLength(1);
  });

  it('rejects a second prompt with Conflict and accepts one after the turn ended', async () => {
    const { driver, session } = setup();
    const first = session.prompt(text('one'));
    await expect(session.prompt(text('two'))).rejects.toBeInstanceOf(Conflict);
    driver.turns[0]?.resolve('end_turn');
    await first;
    const third = session.prompt(text('three'));
    driver.turns[1]?.resolve('end_turn');
    await expect(third).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('types a failure of the turn through the normalizer', async () => {
    const { driver, session } = setup();
    const quota = session.prompt(text('a'));
    driver.turns[0]?.reject(new Error('quota'));
    const error = await quota.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhausted);
    const other = session.prompt(text('b'));
    driver.turns[1]?.reject(new Error('whatever'));
    await expect(other).rejects.toBeInstanceOf(Transient);
  });

  it('lets a typed error of the driver through as it is', async () => {
    const { driver, session } = setup();
    const turn = session.prompt(text('a'));
    const typed = new AdapterUnavailable('gone');
    driver.turns[0]?.reject(typed);
    await expect(turn).rejects.toBe(typed);
  });

  it('turns a normalizer that throws into AdapterUnavailable', async () => {
    const driver = new ScriptedDriver();
    const process = new FakeLaunchedProcess(1, { cmd: 'x', args: [], cwd: '/', env: {} });
    const session = new ManagedAgentSession({
      sessionId: 's',
      canLoad: false,
      driver,
      process,
      normalizer: {
        normalizeUpdate: () => null,
        normalizeError: () => {
          throw new Error('bug');
        },
      },
    });
    const turn = session.prompt(text('a'));
    driver.turns[0]?.reject(new Error('x'));
    await expect(turn).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('cancel asks the client, waits for the turn, ends the tree, and the turn resolves cancelled', async () => {
    const { driver, process, session } = setup();
    const turn = session.prompt(text('hang'));
    const cancelling = session.cancel();
    driver.turns[0]?.resolve('cancelled');
    await cancelling;
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    expect(driver.cancels).toBe(1);
    expect(process.alive).toBe(false);
    expect(process.killTreeCalls).toBe(1);
  });

  it('cancel does not trust the client alone: it ends the tree after the grace period', async () => {
    const { driver, process, session } = setup();
    const turn = session.prompt(text('hang'));
    await session.cancel();
    expect(process.alive).toBe(false);
    expect(driver.disconnects).toBeGreaterThan(0);
    // The client never answered; the cancelled turn still resolves as cancelled, not as an error.
    driver.turns[0]?.reject(new Error('connection closed'));
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('a turn the client never answers still returns once the session let go of the process', async () => {
    const { session, process } = setup();
    // A process shared with other sessions stays up: nothing here ends the connection.
    process.killTree = () => Promise.resolve({ found: 0, forced: false, remaining: [] });
    const turn = session.prompt(text('hang'));
    await session.cancel();
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    const { session: closed, process: other } = setup();
    other.killTree = () => Promise.resolve({ found: 0, forced: false, remaining: [] });
    const open = closed.prompt(text('hang'));
    await closed.close();
    await expect(open).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('tells the process how the cancel went: honoured inside the grace, ignored after it', async () => {
    const seen: (string | undefined)[] = [];
    const watch = (process: FakeLaunchedProcess): void => {
      const killTree = process.killTree.bind(process);
      process.killTree = (options?: KillOptions) => {
        seen.push(options?.cancel);
        return killTree();
      };
    };
    const honored = setup();
    watch(honored.process);
    const turn = honored.session.prompt(text('a'));
    const cancelling = honored.session.cancel();
    honored.driver.turns[0]?.resolve('cancelled');
    await cancelling;
    await turn;
    const ignored = setup();
    watch(ignored.process);
    void ignored.session.prompt(text('a')).catch(() => undefined);
    await ignored.session.cancel();
    const idle = setup();
    watch(idle.process);
    await idle.session.cancel();
    const closed = setup();
    watch(closed.process);
    await closed.session.close();
    expect(seen).toEqual(['honored', 'ignored', 'honored', undefined]);
  });

  it('cancel is idempotent, also when called twice at once', async () => {
    const { process, session } = setup();
    await Promise.all([session.cancel(), session.cancel()]);
    await session.cancel();
    expect(process.killTreeCalls).toBe(1);
  });

  it('cancel rejects when the tree could not be ended', async () => {
    const { process, session } = setup();
    process.leaveBehind = [4242];
    await expect(session.cancel()).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('is unusable after cancel and after close', async () => {
    const cancelled = setup();
    await cancelled.session.cancel();
    await expect(cancelled.session.prompt(text('a'))).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(() => cancelled.session.onUpdate(() => undefined)).toThrow(AdapterUnavailable);

    const closed = setup();
    await closed.session.close();
    await expect(closed.session.prompt(text('a'))).rejects.toBeInstanceOf(AdapterUnavailable);
    await expect(closed.session.setConfig('model', 'x')).rejects.toBeInstanceOf(AdapterUnavailable);
    await expect(closed.session.cancel()).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('close ends the process tree, is idempotent, and works after a cancel', async () => {
    const { process, session } = setup();
    await Promise.all([session.close(), session.close()]);
    await session.close();
    expect(process.killTreeCalls).toBe(1);
    const other = setup();
    await other.session.cancel();
    await other.session.close();
    expect(other.process.alive).toBe(false);
  });

  it('marks the session ended when the process exits by itself', async () => {
    const { driver, process, session } = setup();
    process.exit(1);
    await process.exited;
    await Promise.resolve();
    expect(driver.disconnects).toBe(1);
    await expect(session.prompt(text('a'))).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('passes setConfig to the driver and types its rejection', async () => {
    const { driver, session } = setup();
    await session.setConfig('model', 'm');
    expect(driver.configs).toEqual([['model', 'm']]);
    const invalid = new InvalidInput('no such option');
    driver.failConfig = invalid;
    await expect(session.setConfig('nope', 'x')).rejects.toBe(invalid);
  });

  it('exposes the config options: empty by default, replaced by the driver answer and by updates', async () => {
    const { driver, session } = setup();
    expect(session.configOptions).toEqual([]);
    const high: SessionConfigOption = { id: 'effort', type: 'select', currentValue: 'high' };
    driver.announce = [high];
    await session.setConfig('effort', 'high');
    expect(session.configOptions).toEqual([high]);
    // A driver that does not announce anything leaves the snapshot as it was.
    driver.announce = undefined;
    await session.setConfig('effort', 'high');
    expect(session.configOptions).toEqual([high]);
    const low: SessionConfigOption = { id: 'effort', type: 'select', currentValue: 'low' };
    session.updateConfigOptions([low]);
    expect(session.configOptions).toEqual([low]);
    driver.failConfig = new InvalidInput('no');
    driver.announce = [high];
    await expect(session.setConfig('effort', 'x')).rejects.toBeInstanceOf(InvalidInput);
    expect(session.configOptions).toEqual([low]);
  });

  it('seeds the config options from the options of the constructor', () => {
    const seeded: SessionConfigOption = { id: 'model', type: 'select' };
    const process = new FakeLaunchedProcess(1, { cmd: 'x', args: [], cwd: '/', env: {} });
    const session = new ManagedAgentSession({
      sessionId: 's2',
      canLoad: false,
      driver: new ScriptedDriver(),
      process,
      normalizer,
      configOptions: [seeded],
    });
    expect(session.configOptions).toEqual([seeded]);
  });
});

describe('typedErrorOf', () => {
  it.each([
    ['quota_exhausted', QuotaExhausted],
    ['auth_required', PermissionDenied],
    ['permission', PermissionDenied],
    ['refusal', PermissionDenied],
    ['client_crash', AdapterUnavailable],
    ['transient', Transient],
    ['stuck', Transient],
    ['unknown', Transient],
  ] as const)('maps %s', (kind, expected) => {
    const normalized: NormalizedError = { kind, message: 'm', resetsAt: 5 };
    const error = typedErrorOf(normalized);
    expect(error).toBeInstanceOf(expected);
    expect(error.cause).toBe(normalized);
  });
});
