// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';

describe('profile events (Phase 5, P2)', () => {
  it('[proposta] validates the payloads, strictly, and carries no secret field', () => {
    const added = {
      profileId: 'claude-code/work',
      client: 'claude-code',
      name: 'work',
      kind: 'api',
      provider: 'anthropic',
      hasSecret: true,
      secretBackend: 'encrypted-file',
      login: 'unknown',
      sameProviderNotice: false,
    };
    expect(validateEventPayload('profile.added', 1, added)).toEqual(added);
    expect(() => validateEventPayload('profile.added', 1, { ...added, apiKey: 'x' })).toThrow(
      InvalidInput,
    );
    const removed = {
      profileId: 'claude-code/work',
      loggedOut: true,
      dir: 'deleted',
      secretDeleted: true,
      executorsInvalidated: ['m-high@claude-code/work'],
    };
    expect(validateEventPayload('profile.removed', 1, removed)).toEqual(removed);
    expect(() => validateEventPayload('profile.removed', 1, { ...removed, dir: 'gone' })).toThrow(
      InvalidInput,
    );
    expect(
      validateEventPayload('profile.draining', 1, {
        profileId: 'a/b',
        activeSessions: 2,
        onTimeout: 'handoff',
        timeoutMs: 600000,
      }),
    ).toMatchObject({ onTimeout: 'handoff' });
    expect(
      validateEventPayload('profile.drained', 1, {
        profileId: 'a/b',
        outcome: 'handoff',
        sessions: 1,
      }),
    ).toMatchObject({ outcome: 'handoff' });
    expect(
      validateEventPayload('profile.notice_accepted', 1, {
        profileId: 'a/b',
        provider: 'anthropic',
        sameProvider: ['a/c'],
        mode: 'once',
      }),
    ).toMatchObject({ mode: 'once' });
  });
});
