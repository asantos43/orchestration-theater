// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PermissionDenied } from './errors.js';
import { ModeVetoSession } from './mode-veto-session.js';
import type { AgentSession, SessionConfigOption } from './ports/agent-session.js';

const OPTIONS: SessionConfigOption[] = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [{ value: 'default', name: 'default' }],
  },
];

function inner() {
  const calls: string[] = [];
  const session = {
    sessionId: 's1',
    canLoad: true,
    configOptions: OPTIONS,
    prompt: () => {
      calls.push('prompt');
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    onUpdate: () => {
      calls.push('onUpdate');
      return { dispose: () => Promise.resolve() };
    },
    cancel: () => {
      calls.push('cancel');
      return Promise.resolve();
    },
    setConfig: (id: string, value: unknown) => {
      calls.push(`setConfig:${id}=${String(value)}`);
      return Promise.resolve();
    },
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  } as unknown as AgentSession;
  return { session, calls };
}

describe('ModeVetoSession', () => {
  it('rejects with the refusal and does not reach the session', async () => {
    const { session, calls } = inner();
    const seen: unknown[] = [];
    const wrapped = new ModeVetoSession(session, (id, value, options) => {
      seen.push([id, value, options]);
      return value === 'bad' ? new PermissionDenied('no') : undefined;
    });
    await expect(wrapped.setConfig('mode', 'bad')).rejects.toBeInstanceOf(PermissionDenied);
    expect(calls).toEqual([]);
    expect(seen).toEqual([['mode', 'bad', OPTIONS]]);
    await wrapped.setConfig('mode', 'good');
    expect(calls).toEqual(['setConfig:mode=good']);
  });

  it('forwards everything else as it is', async () => {
    const { session, calls } = inner();
    const wrapped = new ModeVetoSession(session, () => undefined);
    expect(wrapped.sessionId).toBe('s1');
    expect(wrapped.canLoad).toBe(true);
    expect(wrapped.configOptions).toBe(OPTIONS);
    await wrapped.prompt([]);
    wrapped.onUpdate(() => undefined);
    await wrapped.cancel();
    await wrapped.close();
    expect(calls).toEqual(['prompt', 'onUpdate', 'cancel', 'close']);
  });
});
