// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embedPublicKey, embedPublicKeyInFile, InstallScriptError } from './install-script.js';
import { repoRoot } from './resolve.js';
import { generateEphemeralKey } from './sign.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ot-release-install-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const script = async (): Promise<string> =>
  readFile(path.join(repoRoot(), 'installer', 'install.sh'), 'utf8');

describe('embedPublicKey', () => {
  it('puts the key of the release in install.sh and nothing else changes', async () => {
    const original = await script();
    const { publicPem } = generateEphemeralKey();
    const embedded = embedPublicKey(original, publicPem);
    expect(embedded).toContain(`EMBEDDED_PUBLIC_KEY='${publicPem.trim()}'`);
    expect(embedded).not.toContain("EMBEDDED_PUBLIC_KEY='PLACEHOLDER'");
    expect(embedded.replace(publicPem.trim(), 'PLACEHOLDER')).toBe(original);
  });

  it('still parses as a shell script', async () => {
    const { publicPem } = generateEphemeralKey();
    const file = path.join(dir, 'install.sh');
    await writeFile(file, embedPublicKey(await script(), publicPem));
    const result = spawnSync('sh', ['-n', file], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses the PLACEHOLDER, a key that is not a key and a script without the markers', async () => {
    const original = await script();
    const { publicPem } = generateEphemeralKey();
    expect(() => embedPublicKey(original, 'PLACEHOLDER\n')).toThrow(InstallScriptError);
    expect(() => embedPublicKey(original, 'garbage')).toThrow(InstallScriptError);
    expect(() => embedPublicKey('echo hi\n', publicPem)).toThrow(/markers/);
  });

  // Windows has no POSIX mode bits; the script is published from the Linux runner.
  it.skipIf(process.platform === 'win32')('writes the file with the execute bit', async () => {
    const { publicPem } = generateEphemeralKey();
    const key = path.join(dir, 'public.pem');
    const out = path.join(dir, 'out.sh');
    await writeFile(key, publicPem);
    await embedPublicKeyInFile({
      script: path.join(repoRoot(), 'installer', 'install.sh'),
      publicKeyFile: key,
      out,
    });
    expect(((await stat(out)).mode & 0o111) !== 0).toBe(true);
  });
});
