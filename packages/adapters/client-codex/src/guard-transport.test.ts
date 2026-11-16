// SPDX-License-Identifier: MPL-2.0
import {
  PermissionDenied,
  type AgentSession,
  type ConfigValue,
  type SessionOpenParams,
  type SessionTransport,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { guardModes } from './guard-transport.js';
import { DEFAULT_ALLOWED_MODES, DEFAULT_INITIAL_MODE, modePolicyOf } from './modes.js';

const modes = modePolicyOf(DEFAULT_INITIAL_MODE, DEFAULT_ALLOWED_MODES);

/** A transport whose sessions record what reaches the client. */
function recording() {
  const reached: { id: string; value: ConfigValue }[] = [];
  const session: AgentSession = {
    sessionId: 's-1',
    canLoad: true,
    prompt: () => Promise.resolve({ stopReason: 'end_turn' }),
    onUpdate: () => ({ dispose: () => undefined }),
    cancel: () => Promise.resolve(),
    setConfig: (id, value) => {
      reached.push({ id, value });
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const transport: SessionTransport = {
    id: 'acp',
    open: () => Promise.resolve(session),
    load: () => Promise.resolve(session),
  };
  return { reached, transport };
}

const params = {} as SessionOpenParams;

describe('guardModes', () => {
  it('keeps the id of the transport and the identity of the session', async () => {
    const { transport } = recording();
    const guarded = guardModes(transport, modes);
    expect(guarded.id).toBe('acp');
    const session = await guarded.open(params);
    expect(session.sessionId).toBe('s-1');
    expect(session.canLoad).toBe(true);
    await expect(session.prompt([])).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('refuses a vetoed or unlisted mode before it reaches the client, on open and on load', async () => {
    const { reached, transport } = recording();
    const guarded = guardModes(transport, modes);
    for (const session of [
      await guarded.open(params),
      await guarded.load({ ...params, sessionId: 's-1' }),
    ]) {
      for (const mode of ['agent', 'agent-full-access', 'permission-profile:x']) {
        await expect(session.setConfig('mode', mode)).rejects.toBeInstanceOf(PermissionDenied);
      }
      await expect(session.setConfig('mode', true)).rejects.toBeInstanceOf(PermissionDenied);
    }
    expect(reached).toEqual([]);
  });

  it('lets the allowed modes and the other options through', async () => {
    const { reached, transport } = recording();
    const session = await guardModes(transport, modes).open(params);
    await session.setConfig('mode', 'read-only');
    await session.setConfig('model', 'model-a');
    await session.setConfig('reasoning_effort', 'low');
    expect(reached).toEqual([
      { id: 'mode', value: 'read-only' },
      { id: 'model', value: 'model-a' },
      { id: 'reasoning_effort', value: 'low' },
    ]);
  });
});
