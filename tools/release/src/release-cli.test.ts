// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executableAssetName, msiAssetName, noticesAssetName } from './manifest.js';
import { runReleaseCommand } from './release-cli.js';
import { TARGET_IDS } from './targets.js';

let dir: string;
let lines: string[];
const log = (line: string): void => {
  lines.push(line);
};
const run = (command: string, ...args: string[]): Promise<number> =>
  runReleaseCommand(command, args, log);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ot-release-cli-'));
  lines = [];
  await Promise.all(
    TARGET_IDS.flatMap((platform) => [
      writeFile(path.join(dir, executableAssetName(platform)), `exe ${platform}`),
      writeFile(path.join(dir, noticesAssetName(platform)), `notices ${platform}`),
    ]),
  );
  await writeFile(path.join(dir, msiAssetName('1.2.3')), 'msi');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the release commands, as the workflow runs them', () => {
  it('makes a key, assembles, signs and verifies a release, and refuses it once a file changes', async () => {
    const keys = path.join(dir, 'keys');
    expect(await run('ephemeral-key', '--out', keys)).toBe(0);
    // The private half is for the runner alone.
    expect((await stat(path.join(keys, 'ephemeral-private.pem'))).mode & 0o077).toBe(0);

    const manifest = path.join(dir, 'manifest.json');
    expect(await run('assemble', '--dir', dir, '--version', '1.2.3', '--channel', 'stable')).toBe(
      0,
    );
    expect(
      await run(
        'sign',
        '--manifest',
        manifest,
        '--key-file',
        path.join(keys, 'ephemeral-private.pem'),
      ),
    ).toBe(0);
    const verify = (): Promise<number> =>
      run(
        'verify',
        '--manifest',
        manifest,
        '--public-key',
        path.join(keys, 'ephemeral-public.pem'),
        '--dir',
        dir,
      );
    expect(await verify()).toBe(0);

    await writeFile(path.join(dir, executableAssetName('linux-x64')), 'EXE linux-x64');
    expect(await verify()).toBe(1);
    expect(lines.at(-1)).toMatch(/^REFUSED: /);
  });

  it('never prints a private key, and reads the production one from the environment', async () => {
    const keys = path.join(dir, 'keys');
    await run('ephemeral-key', '--out', keys);
    const privatePem = await readFile(path.join(keys, 'ephemeral-private.pem'), 'utf8');
    const publicFile = path.join(keys, 'ephemeral-public.pem');
    process.env.OT_TEST_SIGNING_KEY = privatePem;
    try {
      expect(
        await run('check-key', '--key-env', 'OT_TEST_SIGNING_KEY', '--public-key', publicFile),
      ).toBe(0);
      await run('assemble', '--dir', dir, '--version', '1.2.3', '--channel', 'beta');
      expect(
        await run(
          'sign',
          '--manifest',
          path.join(dir, 'manifest.json'),
          '--key-env',
          'OT_TEST_SIGNING_KEY',
        ),
      ).toBe(0);
      expect(
        await run(
          'verify',
          '--manifest',
          path.join(dir, 'manifest.json'),
          '--public-key',
          publicFile,
        ),
      ).toBe(0);
    } finally {
      delete process.env.OT_TEST_SIGNING_KEY;
    }
    expect(lines.join('\n')).not.toContain('PRIVATE KEY');
    expect(lines.join('\n')).not.toContain(privatePem.split('\n')[1] ?? 'x');
  });

  it('check-key refuses a missing secret and the PLACEHOLDER of the repository', async () => {
    const keys = path.join(dir, 'keys');
    await run('ephemeral-key', '--out', keys);
    delete process.env.OT_TEST_SIGNING_KEY;
    expect(
      await run(
        'check-key',
        '--key-env',
        'OT_TEST_SIGNING_KEY',
        '--public-key',
        path.join(keys, 'ephemeral-public.pem'),
      ),
    ).toBe(1);
    expect(lines.at(-1)).toContain('secret_missing');

    process.env.OT_TEST_SIGNING_KEY = await readFile(
      path.join(keys, 'ephemeral-private.pem'),
      'utf8',
    );
    try {
      const placeholder = path.join(dir, 'placeholder.pem');
      await writeFile(placeholder, 'PLACEHOLDER\n');
      expect(
        await run('check-key', '--key-env', 'OT_TEST_SIGNING_KEY', '--public-key', placeholder),
      ).toBe(1);
      expect(lines.at(-1)).toContain('public_placeholder');
      // The real file of the repository is still the placeholder: a release cannot be signed yet.
      const repository = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        'keys',
        'update-public-key.pem',
      );
      expect(
        await run('check-key', '--key-env', 'OT_TEST_SIGNING_KEY', '--public-key', repository),
      ).toBe(1);
    } finally {
      delete process.env.OT_TEST_SIGNING_KEY;
    }
  });

  it('refuses a release without a platform, a channel that does not exist and a call without the options', async () => {
    await rm(path.join(dir, executableAssetName('darwin-arm64')));
    expect(await run('assemble', '--dir', dir, '--version', '1.2.3', '--channel', 'stable')).toBe(
      1,
    );
    expect(lines.at(-1)).toMatch(/no executable for darwin-arm64/);
    expect(await run('assemble', '--dir', dir, '--version', '1.2.3', '--channel', 'nightly')).toBe(
      2,
    );
    expect(await run('sign', '--manifest', path.join(dir, 'manifest.json'))).toBe(2);
    expect(await run('verify')).toBe(2);
  });
});
