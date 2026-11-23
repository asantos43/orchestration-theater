// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseManifest } from '@otheater/daemon/updates/manifest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleFromDirectory,
  assembleManifest,
  discoverAssets,
  executableAssetName,
  ManifestAssemblyError,
  msiAssetName,
  noticesAssetName,
} from './manifest.js';
import { generateEphemeralKey, signManifest } from './sign.js';
import { ReleaseVerifyError, verifyRelease } from './verify.js';
import { TARGET_IDS } from './targets.js';

const VERSION = '1.2.3';
const NOW = new Date('2026-11-22T15:00:00Z');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ot-release-manifest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A folder as the release job leaves it: an executable and the notices of each platform, and the msi. */
async function writeRelease(skip: readonly string[] = []): Promise<void> {
  const put = async (name: string, text: string): Promise<void> => {
    if (!skip.includes(name)) await writeFile(path.join(dir, name), text);
  };
  for (const platform of TARGET_IDS) {
    await put(executableAssetName(platform), `executable of ${platform}`);
    await put(noticesAssetName(platform), `notices of ${platform}`);
  }
  await put(msiAssetName(VERSION), 'the msi');
  // Files that sit in the same folder and are not assets:
  await put('manifest.json.sig', 'x');
  await put('install.sh', 'x');
}

describe('asset names', () => {
  it('names the files as the installer and the updates look for them', () => {
    expect(executableAssetName('win32-x64')).toBe('otheater-win32-x64.exe');
    expect(executableAssetName('linux-x64')).toBe('otheater-linux-x64');
    expect(noticesAssetName('darwin-arm64')).toBe('THIRD_PARTY_NOTICES-darwin-arm64.md');
    expect(msiAssetName('1.2.3')).toBe('OTheater-1.2.3-win32-x64.msi');
    expect(msiAssetName('1.2.3-rc.1+build.5')).toBe('OTheater-1.2.3-rc.1-win32-x64.msi');
  });
});

describe('assemble', () => {
  it('finds the executables, the notices and the msi, and leaves the rest alone', async () => {
    await writeRelease();
    const found = await discoverAssets(dir, VERSION);
    expect(found.map((a) => `${a.platform}:${a.kind}`).sort()).toEqual([
      'darwin-arm64:exe',
      'darwin-arm64:notices',
      'linux-x64:exe',
      'linux-x64:notices',
      'win32-x64:exe',
      'win32-x64:msi',
      'win32-x64:notices',
    ]);
  });

  it('writes a manifest the daemon reads, with the size and the SHA-256 of each file', async () => {
    await writeRelease();
    const out = path.join(dir, 'manifest.json');
    const { manifest, bytes } = await assembleFromDirectory({
      dir,
      out,
      version: VERSION,
      channel: 'beta',
      requiredPlatforms: TARGET_IDS,
      schemas: { store: 10, telemetry: 3 },
      now: NOW,
    });
    expect(Buffer.compare(await readFile(out), bytes)).toBe(0);
    const read = parseManifest(bytes);
    expect(read).toEqual(manifest);
    expect(read.channel).toBe('beta');
    expect(read.publishedAt).toBe(NOW.toISOString());
    expect(read.schemas).toEqual({ store: 10, telemetry: 3 });
    const linux = read.assets.find((a) => a.name === 'otheater-linux-x64');
    expect(linux).toMatchObject({
      platform: 'linux-x64',
      kind: 'exe',
      size: 'executable of linux-x64'.length,
    });
    expect(linux?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.assets.some((a) => a.kind === 'notices')).toBe(true);
  });

  it('refuses a release without the executable of a required platform', async () => {
    await writeRelease([executableAssetName('darwin-arm64')]);
    await expect(
      assembleFromDirectory({
        dir,
        out: path.join(dir, 'manifest.json'),
        version: VERSION,
        channel: 'stable',
        requiredPlatforms: TARGET_IDS,
      }),
    ).rejects.toThrow(/no executable for darwin-arm64/);
  });

  it('refuses a version that is not a version, and a folder that is not there', async () => {
    await writeRelease();
    await expect(
      assembleManifest({
        version: 'latest',
        channel: 'stable',
        assets: await discoverAssets(dir, VERSION),
      }),
    ).rejects.toThrow(ManifestAssemblyError);
    await expect(
      assembleFromDirectory({
        dir: path.join(dir, 'nowhere'),
        out: path.join(dir, 'm.json'),
        version: VERSION,
        channel: 'stable',
      }),
    ).rejects.toThrow(/not a folder/);
  });

  it('refuses two assets with the same name', async () => {
    await writeRelease();
    await mkdir(path.join(dir, 'other'));
    await writeFile(path.join(dir, 'other', 'otheater-linux-x64'), 'again');
    const assets = await discoverAssets(dir, VERSION);
    const linux = assets.find((a) => a.platform === 'linux-x64' && a.kind === 'exe');
    if (linux === undefined) throw new Error('fixture');
    await expect(
      assembleManifest({
        version: VERSION,
        channel: 'stable',
        assets: [...assets, { ...linux, file: path.join(dir, 'other', 'otheater-linux-x64') }],
      }),
    ).rejects.toThrow(/same name/);
  });
});

describe('sign and verify', () => {
  async function assembled() {
    await writeRelease();
    const result = await assembleFromDirectory({
      dir,
      out: path.join(dir, 'manifest.json'),
      version: VERSION,
      channel: 'stable',
      requiredPlatforms: TARGET_IDS,
      now: NOW,
    });
    return result.bytes;
  }

  it('signs and checks a release, files included', async () => {
    const bytes = await assembled();
    const keys = generateEphemeralKey();
    const signature = signManifest(bytes, keys.privatePem);
    const manifest = await verifyRelease({
      manifestBytes: bytes,
      signature,
      publicPem: keys.publicPem,
      assetsDir: dir,
    });
    expect(manifest.version).toBe(VERSION);
  });

  it('refuses the signature of another key', async () => {
    const bytes = await assembled();
    const signer = generateEphemeralKey();
    const other = generateEphemeralKey();
    await expect(
      verifyRelease({
        manifestBytes: bytes,
        signature: signManifest(bytes, signer.privatePem),
        publicPem: other.publicPem,
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('refuses a manifest changed after it was signed, by one byte', async () => {
    const bytes = await assembled();
    const keys = generateEphemeralKey();
    const signature = signManifest(bytes, keys.privatePem);
    const changed = Buffer.from(bytes.toString('utf8').replace('"stable"', '"beta"'));
    await expect(
      verifyRelease({ manifestBytes: changed, signature, publicPem: keys.publicPem }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('refuses the PLACEHOLDER as the key to check with', async () => {
    const bytes = await assembled();
    const keys = generateEphemeralKey();
    const error = await verifyRelease({
      manifestBytes: bytes,
      signature: signManifest(bytes, keys.privatePem),
      publicPem: 'PLACEHOLDER\n',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseVerifyError);
    expect((error as ReleaseVerifyError).reason).toBe('key_placeholder');
  });

  it('refuses a signed manifest that is not a manifest', async () => {
    const keys = generateEphemeralKey();
    const bytes = Buffer.from('{"schema":1}');
    await expect(
      verifyRelease({
        manifestBytes: bytes,
        signature: signManifest(bytes, keys.privatePem),
        publicPem: keys.publicPem,
      }),
    ).rejects.toMatchObject({ reason: 'bad_manifest' });
  });

  it('refuses a file that changed, one that has another size and one that is gone', async () => {
    const bytes = await assembled();
    const keys = generateEphemeralKey();
    const signature = signManifest(bytes, keys.privatePem);
    const check = () =>
      verifyRelease({ manifestBytes: bytes, signature, publicPem: keys.publicPem, assetsDir: dir });
    const file = path.join(dir, 'otheater-linux-x64');
    // same size, other content
    await writeFile(file, 'EXECUTABLE of linux-x64');
    await expect(check()).rejects.toMatchObject({ reason: 'hash_mismatch' });
    await writeFile(file, 'short');
    await expect(check()).rejects.toMatchObject({ reason: 'size_mismatch' });
    await rm(file);
    await expect(check()).rejects.toMatchObject({ reason: 'missing_file' });
  });
});
