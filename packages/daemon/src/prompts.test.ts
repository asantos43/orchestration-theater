// SPDX-License-Identifier: MPL-2.0
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, OFFICIAL_ROLES, type Store } from '@otheater/core';
import {
  FakeClock,
  InMemoryPromptSource,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig, PROMPT_ADAPTER_IDS } from './config.js';
import { startDaemon } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { defaultPromptSource } from './prompts.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

const MANUAL = parseConfig('backup:\n  when: manual\n');

/** A valid prompt for every role, with `overrides` replacing some. */
function prompts(overrides: Record<string, string> = {}): Record<string, string> {
  const all: Record<string, string> = {};
  for (const role of OFFICIAL_ROLES) all[role.id] = `You are the ${role.id}.`;
  return { ...all, ...overrides };
}

describe('the prompts config keys', () => {
  it('default to the files adapter with no options', () => {
    const config = parseConfig('');
    expect(config.adapters.prompts).toBe('files');
    expect(config.prompts).toEqual({});
    expect(PROMPT_ADAPTER_IDS).toEqual(['files']);
  });

  it('refuse an adapter that does not exist, naming the key', () => {
    expect(() => parseConfig('adapters:\n  prompts: database\n')).toThrow(/adapters\.prompts/);
  });
});

describe('defaultPromptSource', () => {
  it('reads the bundled prompts when no directory is configured', async () => {
    const source = defaultPromptSource(MANUAL, '/data');
    expect(await source.roles()).toEqual(OFFICIAL_ROLES.map((role) => role.id).sort());
  });

  it('reads a relative directory against the data directory, and an absolute one as it is', async () => {
    const tmp = await makeTempDataDir();
    try {
      await mkdir(join(tmp.dir, 'mine'));
      await writeFile(join(tmp.dir, 'mine', 'actor.md'), 'You are my actor.');
      const relative = defaultPromptSource(parseConfig('prompts:\n  directory: mine\n'), tmp.dir);
      expect(await relative.get('actor')).toBe('You are my actor.');
      const absolute = defaultPromptSource(
        parseConfig(`prompts:\n  directory: ${join(tmp.dir, 'mine')}\n`),
        '/elsewhere',
      );
      expect(await absolute.roles()).toEqual(['actor']);
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses an unknown option of the section, naming prompts.<key>', () => {
    expect(() => defaultPromptSource(parseConfig('prompts:\n  folder: x\n'), '/data')).toThrow(
      /config\.yaml: prompts\./,
    );
  });
});

describe('starting the daemon with the prompts', () => {
  it('starts with the bundled prompts', async () => {
    const tmp = await makeTempDataDir();
    try {
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: {
          clock: new FakeClock(),
          store: new InMemoryStore({ clock: new FakeClock() }),
          vault: new InMemorySecretVault(),
        },
        logger: createSilentLogger(),
      });
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses to start when a prompt cites a tool its role cannot call, and never opens the store', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 17, 12));
      const inner = new InMemoryStore({ clock });
      let touched = 0;
      const store = new Proxy(inner, {
        get(target, property) {
          touched += 1;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as Store;
      const bad = new InMemoryPromptSource(
        prompts({
          reviewer: 'When you are done, call `submit_plan(plan)`.',
          actor: 'Call `fly_away(now)`.',
        }),
      );
      const failure: unknown = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        prompts: bad,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidInput);
      const message = (failure as Error).message;
      expect(message).toContain('prompts/reviewer:');
      expect(message).toContain('[tool_not_for_role]');
      expect(message).toContain('prompts/actor:');
      expect(message).toContain('[unknown_tool]');
      expect(touched).toBe(0);

      // The lock was released: the same data directory starts with valid prompts.
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store: inner, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        prompts: new InMemoryPromptSource(prompts()),
      });
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses to start when a role has no prompt, without creating the database file', async () => {
    const tmp = await makeTempDataDir();
    try {
      const incomplete = prompts();
      delete incomplete.critic;
      await expect(
        startDaemon({
          dataDir: tmp.dir,
          clientSearch: NO_CLIENTS,
          config: MANUAL,
          overrides: { vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
          prompts: new InMemoryPromptSource(incomplete),
        }),
      ).rejects.toThrow(/prompts\/critic: .*\[missing_prompt\]/);
      await expect(access(join(tmp.dir, 'store.sqlite'))).rejects.toThrow();
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses to start when the configured prompts folder is missing', async () => {
    const tmp = await makeTempDataDir();
    try {
      await expect(
        startDaemon({
          dataDir: tmp.dir,
          clientSearch: NO_CLIENTS,
          config: parseConfig('backup:\n  when: manual\nprompts:\n  directory: nowhere\n'),
          overrides: { vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
        }),
      ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    } finally {
      await tmp.dispose();
    }
  });
});
