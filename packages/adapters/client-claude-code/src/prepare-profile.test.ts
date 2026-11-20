// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInput, type Profile, type RolePolicy } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deniedTools } from './policy.js';
import { PROFILE_SETTINGS_FILE, writeProfileSettings } from './prepare-profile.js';
import {
  STATUSLINE_SCRIPT,
  STATUSLINE_SCRIPT_FILE,
  statuslineSetting,
} from './quota-statusline.js';

const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

let root: string;
let profile: Profile;
let settingsPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-claude-profile-'));
  const dir = join(root, 'claude-code', 'p');
  profile = { client: 'claude-code', profile: 'p', id: 'claude-code/p', dir };
  settingsPath = join(dir, PROFILE_SETTINGS_FILE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function read(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
}

describe('writeProfileSettings', () => {
  it('creates the directory and the three permission keys', async () => {
    await writeProfileSettings(profile, policy, { quotaStatusline: 'off' });
    expect(await read()).toEqual({
      permissions: {
        defaultMode: 'default',
        disableBypassPermissionsMode: 'disable',
        deny: deniedTools(policy),
      },
    });
  });

  it('writes acceptEdits as defaultMode for a role that edits or writes (N180)', async () => {
    await writeProfileSettings(
      profile,
      { ...policy, nativeTools: ['read', 'edit', 'write'], editInWorktree: 'allow' },
      {
        quotaStatusline: 'off',
      },
    );
    const permissions = (await read()).permissions as Record<string, unknown>;
    expect(permissions.defaultMode).toBe('acceptEdits');
    await writeProfileSettings(profile, policy, { quotaStatusline: 'off' });
    expect(((await read()).permissions as Record<string, unknown>).defaultMode).toBe('default');
    // N182: with edit_in_worktree: ask the role keeps its tools but the mode is the default one.
    await writeProfileSettings(
      profile,
      { ...policy, nativeTools: ['read', 'edit', 'write'], editInWorktree: 'ask' },
      { quotaStatusline: 'off' },
    );
    expect(((await read()).permissions as Record<string, unknown>).defaultMode).toBe('default');
  });

  it('does not write the MCP allow rules: they travel in the session, not in the shared file', async () => {
    await writeProfileSettings(profile, { ...policy, mcpServers: ['otheater'] });
    const permissions = (await read()).permissions as Record<string, unknown>;
    expect(permissions).not.toHaveProperty('allow');
  });

  it('keeps the other keys and the other deny entries, and replaces the managed ones', async () => {
    await mkdir(profile.dir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Bash(ls:*)'], deny: ['Read', 'WebFetch', 'Bash(rm:*)'] },
      }),
    );
    await writeProfileSettings(profile, policy);
    const settings = await read();
    expect(settings.theme).toBe('dark');
    const permissions = settings.permissions as Record<string, unknown>;
    expect(permissions.allow).toEqual(['Bash(ls:*)']);
    // `Read` is granted by this policy, so it leaves `deny`; the entries that are not ours stay.
    expect(permissions.deny).toEqual(['WebFetch', 'Bash(rm:*)', ...deniedTools(policy)]);
  });

  it('is idempotent', async () => {
    await writeProfileSettings(profile, policy);
    const first = await readFile(settingsPath, 'utf8');
    await writeProfileSettings(profile, policy);
    expect(await readFile(settingsPath, 'utf8')).toBe(first);
  });

  it('leaves a file that is not valid JSON as it is and rejects', async () => {
    await mkdir(profile.dir, { recursive: true });
    await writeFile(settingsPath, '{ not json');
    await expect(writeProfileSettings(profile, policy)).rejects.toBeInstanceOf(InvalidInput);
    expect(await readFile(settingsPath, 'utf8')).toBe('{ not json');
  });

  it('rejects a file that is JSON but not an object', async () => {
    await mkdir(profile.dir, { recursive: true });
    await writeFile(settingsPath, '[1, 2]');
    await expect(writeProfileSettings(profile, policy)).rejects.toBeInstanceOf(InvalidInput);
    expect(await readFile(settingsPath, 'utf8')).toBe('[1, 2]');
  });

  it('never touches another file of the profile directory, and leaves no temporary file', async () => {
    await mkdir(profile.dir, { recursive: true });
    const decoy = join(profile.dir, 'decoy-other-file.json');
    await writeFile(decoy, 'placeholder-not-a-credential');
    await writeProfileSettings(profile, policy);
    expect(await readFile(decoy, 'utf8')).toBe('placeholder-not-a-credential');
    expect((await readdir(profile.dir)).sort()).toEqual([
      'decoy-other-file.json',
      STATUSLINE_SCRIPT_FILE,
      'settings.json',
    ]);
  });
});

describe('writeProfileSettings, the quota statusline (P6)', () => {
  const nodePath = '/opt/node/bin/node';

  it('by default writes the statusLine command and the script next to the settings', async () => {
    await writeProfileSettings(profile, policy, { nodePath });
    const settings = await read();
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `'${nodePath}' '${join(profile.dir, STATUSLINE_SCRIPT_FILE)}'`,
    });
    expect(await readFile(join(profile.dir, STATUSLINE_SCRIPT_FILE), 'utf8')).toBe(
      STATUSLINE_SCRIPT,
    );
  });

  it("replaces a statusLine that is not ours: the profile is OTheater's, not the user's", async () => {
    await mkdir(profile.dir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }),
    );
    await writeProfileSettings(profile, policy, { nodePath });
    expect((await read()).statusLine).toMatchObject({
      command: expect.stringContaining(STATUSLINE_SCRIPT_FILE) as string,
    });
  });

  it('is idempotent with the statusline on', async () => {
    await writeProfileSettings(profile, policy, { nodePath });
    const first = await readFile(settingsPath, 'utf8');
    await writeProfileSettings(profile, policy, { nodePath });
    expect(await readFile(settingsPath, 'utf8')).toBe(first);
  });

  it('with `off` writes no script and takes out a statusLine of ours, keeping another', async () => {
    await writeProfileSettings(profile, policy, { nodePath });
    await writeProfileSettings(profile, policy, { quotaStatusline: 'off' });
    expect(await read()).not.toHaveProperty('statusLine');

    await writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }),
    );
    await writeProfileSettings(profile, policy, { quotaStatusline: 'off' });
    expect((await read()).statusLine).toEqual({ type: 'command', command: 'echo hi' });
  });

  // The command is a sh line with POSIX paths; how Windows runs the statusline is not measured.
  it.skipIf(process.platform === 'win32')('quotes a path with a space or a quote for sh', () => {
    const setting = statuslineSetting("/tmp/it's here/p", '/opt/my node/node');
    expect(setting.command).toBe(
      "'/opt/my node/node' '/tmp/it'\\''s here/p/otheater-statusline.mjs'",
    );
  });
});
