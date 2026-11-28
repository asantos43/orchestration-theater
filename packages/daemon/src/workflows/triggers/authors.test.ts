// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { AuthorGate, COLLABORATOR_TTL_MS } from './authors.js';
import type { WorkflowTriggersSettings } from './config.js';
import { FakeCollaborators } from './triggers.test-support.js';

function gate(
  settings: Pick<WorkflowTriggersSettings, 'authors' | 'authors_list'>,
  collaborators?: FakeCollaborators,
): { gate: AuthorGate; clock: FakeClock } {
  const clock = new FakeClock();
  return { gate: new AuthorGate({ clock, settings: () => settings, collaborators }), clock };
}

describe('AuthorGate', () => {
  it('allowlist: only the logins of the list, whatever their case; an empty list allows nobody', async () => {
    const { gate: closed } = gate({ authors: 'allowlist', authors_list: [] });
    expect((await closed.check('o/r', 'anyone')).allowed).toBe(false);

    const { gate: listed } = gate({ authors: 'allowlist', authors_list: ['Alice'] });
    expect((await listed.check('o/r', 'alice')).allowed).toBe(true);
    expect((await listed.check('o/r', 'ALICE')).allowed).toBe(true);
    const bob = await listed.check('o/r', 'bob');
    expect(bob.allowed).toBe(false);
    expect('detail' in bob && bob.detail).toContain('authors_list');
  });

  it('any: everybody', async () => {
    const { gate: open } = gate({ authors: 'any', authors_list: [] });
    expect((await open.check('o/r', 'stranger')).allowed).toBe(true);
  });

  it('collaborators: asks the host, keeps the answer for a while, and trusts the list too', async () => {
    const collaborators = new FakeCollaborators();
    collaborators.logins.add('partner');
    const { gate: g, clock } = gate(
      { authors: 'collaborators', authors_list: ['bot'] },
      collaborators,
    );
    expect((await g.check('o/r', 'partner')).allowed).toBe(true);
    expect((await g.check('o/r', 'partner')).allowed).toBe(true);
    expect(collaborators.calls).toBe(1);
    expect((await g.check('o/r', 'outsider')).allowed).toBe(false);
    expect((await g.check('o/r', 'bot')).allowed).toBe(true);
    expect(collaborators.calls).toBe(2);

    // The same login of another repository is another question, and the answer expires.
    await g.check('o/other', 'partner');
    expect(collaborators.calls).toBe(3);
    await clock.advance(COLLABORATOR_TTL_MS);
    await g.check('o/r', 'partner');
    expect(collaborators.calls).toBe(4);
  });

  it('collaborators without a way to ask allows only the list', async () => {
    const { gate: g } = gate({ authors: 'collaborators', authors_list: ['bot'] });
    expect((await g.check('o/r', 'bot')).allowed).toBe(true);
    expect((await g.check('o/r', 'partner')).allowed).toBe(false);
  });

  it('a failed question is thrown, never read as a no', async () => {
    const failing = {
      isCollaborator: (): Promise<boolean> => Promise.reject(new Error('rate limited')),
    };
    const { gate: g } = gate({ authors: 'collaborators', authors_list: [] }, failing as never);
    await expect(g.check('o/r', 'partner')).rejects.toThrow('rate limited');
  });
});
