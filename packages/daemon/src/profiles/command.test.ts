// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../cli.js';
import type { ClientFactory } from '../clients.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';

const KEY = 'sk-test-cli-0123456789-NEVER-PRINTED';
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

interface Rig {
  readonly dir: string;
  readonly vault: InMemorySecretVault;
  readonly loggedOut: string[];
  run(
    argv: readonly string[],
    extra?: Partial<CliDeps>,
  ): Promise<{ code: number; out: string[]; err: string[] }>;
  json(
    argv: readonly string[],
    extra?: Partial<CliDeps>,
  ): Promise<{ code: number; value: unknown }>;
}

function rigFor(dir: string): Rig {
  const vault = new InMemorySecretVault();
  const clock = new FakeClock(NOW);
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const loggedOut: string[] = [];
  const clients: ClientFactory = (parts) =>
    ['claude-code', 'codex'].map(
      (id) =>
        new FakeClientAdapter({
          id,
          launcher: parts.launcher,
          baseEnv: { PATH: '/bin' },
          adapterVersion: '1.0.0',
          command: { cmd: 'fake-client', args: ['--acp'] },
          loginState: 'logged_in',
          onLogout: (profile) => loggedOut.push(profile.id),
        }),
    );
  const run: Rig['run'] = async (argv, extra = {}) => {
    const captured = { out: [] as string[], err: [] as string[] };
    const code = await main([...argv, '--data-dir', dir], {
      env: { MY_KEY: KEY, EMPTY_KEY: '' },
      platform: 'linux',
      homedir: dir,
      out: (line) => captured.out.push(line),
      err: (line) => captured.err.push(line),
      systemLocale: 'en',
      version: '1.2.3',
      overrides: { clock, vault, launcher, transport },
      clients,
      ...extra,
    });
    return { ...captured, code };
  };
  const json: Rig['json'] = async (argv, extra) => {
    const result = await run([...argv, '--json'], extra);
    return { code: result.code, value: JSON.parse(result.out.join('\n')) as unknown };
  };
  return { dir, vault, loggedOut, run, json };
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  try {
    await body(rigFor(tmp.dir));
  } finally {
    await tmp.dispose();
  }
}

describe('ot profile add, list, drain and remove', () => {
  it('registers three profiles: the notice shows once, never for the API key, and the key stays in the vault', async () => {
    await withRig(async (rig) => {
      const first = await rig.json(['profile', 'add', 'claude-code', 'one']);
      expect(first.code).toBe(0);
      expect(first.value).toMatchObject({
        status: 'added',
        profile: { id: 'claude-code/one', kind: 'token_plan', provider: 'anthropic' },
        hasSecret: false,
        login: 'logged_in',
        notice: null,
      });

      // The second subscription of the same provider: nothing is made without the acceptance.
      const refused = await rig.json(['profile', 'add', 'claude-code', 'two']);
      expect(refused.code).toBe(1);
      expect(refused.value).toMatchObject({
        status: 'needs_notice',
        notice: { provider: 'anthropic', existing: ['claude-code/one'], mode: 'once' },
      });
      const text = await rig.run(['profile', 'add', 'claude-code', 'two']);
      expect(text.code).toBe(1);
      expect(text.out.join('\n')).toMatch(/does not check whether the terms/);
      expect(text.out.join('\n')).toMatch(/--accept-notice/);
      const profilesDir = dataPaths(rig.dir).profiles;
      expect(existsSync(join(profilesDir, 'claude-code', 'two'))).toBe(false);

      const second = await rig.json(['profile', 'add', 'claude-code', 'two', '--accept-notice']);
      expect(second.code).toBe(0);
      expect(second.value).toMatchObject({ notice: { provider: 'anthropic' } });

      // The API profile never asks for the notice, and the key reaches only the vault.
      const api = await rig.json([
        'profile',
        'add',
        'claude-code',
        'metered',
        '--kind',
        'api',
        '--api-key-env',
        'MY_KEY',
      ]);
      expect(api.code).toBe(0);
      expect(api.value).toMatchObject({
        status: 'added',
        hasSecret: true,
        login: null,
        notice: null,
      });
      expect(JSON.stringify(api.value)).not.toContain(KEY);
      expect((await rig.vault.get('profile/claude-code/metered/api-key'))?.reveal()).toBe(KEY);

      const listed = await rig.json(['profile', 'list']);
      expect((listed.value as { profile: { id: string } }[]).map((s) => s.profile.id)).toEqual([
        'claude-code/metered',
        'claude-code/one',
        'claude-code/two',
      ]);
      const plain = await rig.run(['profile', 'list']);
      expect(plain.out.join('\n')).toContain(
        'claude-code/metered [active] api anthropic key=vault',
      );
      expect(plain.out.join('\n')).not.toContain(KEY);
    });
  });

  it('takes the key from the standard input, and never prints it', async () => {
    await withRig(async (rig) => {
      const result = await rig.run(
        ['profile', 'add', 'codex', 'paid', '--kind', 'api', '--api-key-stdin'],
        { input: Readable.from([`${KEY}\n`]) },
      );
      expect(result.code).toBe(0);
      expect(result.out.join('\n')).toContain(
        'Profile codex/paid registered (api, provider openai).',
      );
      expect(result.out.join('\n')).toMatch(/The key is in the vault \(/);
      expect([...result.out, ...result.err].join('\n')).not.toContain(KEY);
      expect((await rig.vault.get('profile/codex/paid/api-key'))?.reveal()).toBe(KEY);
    });
  });

  it('does not keep the key in any file of the data directory', async () => {
    await withRig(async (rig) => {
      await rig.run([
        'profile',
        'add',
        'codex',
        'paid',
        '--kind',
        'api',
        '--api-key-env',
        'MY_KEY',
      ]);
      const seen: string[] = [];
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) seen.push(await readFile(path, 'utf8').catch(() => ''));
        }
      };
      await walk(rig.dir);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((content) => content.includes(KEY))).toEqual([]);
    });
  });

  it('drains a profile (no new session) and removes it, leaving its Executors invalid', async () => {
    await withRig(async (rig) => {
      await rig.run(['profile', 'add', 'codex', 'main']);
      const dir = join(dataPaths(rig.dir).profiles, 'codex', 'main');
      expect(existsSync(dir)).toBe(true);

      const drained = await rig.json(['profile', 'drain', 'codex/main']);
      expect(drained.code).toBe(0);
      expect(drained.value).toMatchObject({
        profile: { id: 'codex/main', state: 'draining' },
        outcome: 'finished',
        sessions: 0,
      });
      const listed = await rig.run(['profile', 'list']);
      expect(listed.out.join('\n')).toContain('codex/main [draining]');

      const removed = await rig.json(['profile', 'remove', 'codex/main']);
      expect(removed.code).toBe(0);
      expect(removed.value).toMatchObject({
        profile: { id: 'codex/main', state: 'removed' },
        loggedOut: true,
        dir: 'deleted',
        executorsInvalidated: [],
      });
      expect(rig.loggedOut).toEqual(['codex/main']);
      expect(existsSync(dir)).toBe(false);

      const hidden = await rig.run(['profile', 'list']);
      expect(hidden.out).toEqual(['No profiles.']);
      const all = await rig.run(['profile', 'list', '--all']);
      expect(all.out.join('\n')).toContain('codex/main [removed]');
    });
  });

  it('removes an API profile together with its key, and a text report says so', async () => {
    await withRig(async (rig) => {
      await rig.run([
        'profile',
        'add',
        'codex',
        'paid',
        '--kind',
        'api',
        '--api-key-env',
        'MY_KEY',
      ]);
      const removed = await rig.run(['profile', 'remove', 'codex/paid']);
      expect(removed.code).toBe(0);
      expect(removed.out).toContain('Profile codex/paid removed.');
      expect(removed.out).toContain('The key was removed from the vault.');
      expect(await rig.vault.get('profile/codex/paid/api-key')).toBeUndefined();
    });
  });

  it('asks the login of each profile with --check-login, and filters by --client', async () => {
    await withRig(async (rig) => {
      await rig.run(['profile', 'add', 'codex', 'main']);
      await rig.run(['profile', 'add', 'claude-code', 'main']);
      const checked = await rig.json(['profile', 'list', '--check-login', '--client', 'codex']);
      expect(checked.value).toHaveLength(1);
      expect(checked.value).toMatchObject([{ profile: { id: 'codex/main' }, login: 'logged_in' }]);
    });
  });

  it('fails with exit 1 and no side effect when the key has nowhere to come from', async () => {
    await withRig(async (rig) => {
      const empty = await rig.run([
        'profile',
        'add',
        'codex',
        'paid',
        '--kind',
        'api',
        '--api-key-env',
        'EMPTY_KEY',
      ]);
      expect(empty.code).toBe(1);
      expect(empty.err.join('\n')).toMatch(/EMPTY_KEY is empty or not set/);
      const noLine = await rig.run(
        ['profile', 'add', 'codex', 'paid', '--kind', 'api', '--api-key-stdin'],
        { input: Readable.from([]) },
      );
      expect(noLine.code).toBe(1);
      expect(noLine.err.join('\n')).toMatch(/no key on its first line/);
      expect(existsSync(join(dataPaths(rig.dir).profiles, 'codex', 'paid'))).toBe(false);
    });
  });

  it('reports a duplicate or unknown profile as a failed command (exit 1)', async () => {
    await withRig(async (rig) => {
      await rig.run(['profile', 'add', 'codex', 'main']);
      const again = await rig.run(['profile', 'add', 'codex', 'main']);
      expect(again.code).toBe(1);
      expect(again.err.join('\n')).toMatch(/already exists/);
      const unknown = await rig.run(['profile', 'drain', 'codex/none']);
      expect(unknown.code).toBe(1);
      expect(unknown.err[0]).toMatch(/^Error: /);
      // N326: a client the daemon cannot run is a usage error, and nothing is made.
      const client = await rig.run(['profile', 'add', 'cursor', 'main', '--provider', 'anthropic']);
      expect(client.code).toBe(2);
      expect(client.err.join('\n')).toMatch(/unknown client "cursor"; the clients are claude-code/);
      expect(existsSync(join(dataPaths(rig.dir).profiles, 'cursor'))).toBe(false);
    });
  });

  it('refuses while a daemon holds the data directory, and speaks pt-BR when asked', async () => {
    await withRig(async (rig) => {
      const paths = dataPaths(rig.dir);
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const refused = await rig.run(['profile', 'list'], { systemLocale: 'pt-BR' });
        expect(refused.code).toBe(1);
        expect(refused.err[0]).toMatch(/O daemon está rodando/);
      } finally {
        await lock.release();
      }
      const empty = await rig.run(['profile', 'list'], { systemLocale: 'pt-BR' });
      expect(empty.out).toEqual(['Nenhum perfil.']);
    });
  });

  it.each([
    ['no action', ['profile'], /needs an action/],
    ['an unknown action', ['profile', 'burn'], /Unknown action "burn"/],
    ['add without the name', ['profile', 'add', 'codex'], /needs the client and the profile name/],
    [
      'an unknown client without --provider',
      ['profile', 'add', 'opencode', 'x'],
      /needs --provider/,
    ],
    ['an unknown kind', ['profile', 'add', 'codex', 'x', '--kind', 'free'], /--kind must be/],
    [
      'an API profile without a key',
      ['profile', 'add', 'codex', 'x', '--kind', 'api'],
      /needs the key/,
    ],
    [
      'a key on a subscription',
      ['profile', 'add', 'codex', 'x', '--api-key-env', 'MY_KEY'],
      /only for --kind api/,
    ],
    [
      'two key sources',
      ['profile', 'add', 'codex', 'x', '--kind', 'api', '--api-key-env', 'A', '--api-key-stdin'],
      /only one of/,
    ],
    ['drain without an id', ['profile', 'drain'], /needs the profile id/],
    ['remove with two ids', ['profile', 'remove', 'a/b', 'c/d'], /Too many arguments/],
    ['list with an argument', ['profile', 'list', 'x'], /Too many arguments/],
  ])('exits 2 with a hint for %s', async (_name, argv, message) => {
    await withRig(async (rig) => {
      const result = await rig.run(argv);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(message);
      expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
    });
  });
});
