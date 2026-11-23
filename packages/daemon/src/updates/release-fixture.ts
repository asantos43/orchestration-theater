// SPDX-License-Identifier: MPL-2.0
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { GITHUB_REPOSITORY, type FetchFunction } from './source.js';

/**
 * What the tests of the updates (P7) build a release from: a key pair made in the test (nothing
 * secret is in the repository), a signed manifest, an executable, and an origin that serves them
 * without the network. Tests only.
 */

export interface TestKeys {
  readonly publicPem: string;
  readonly publicKey: KeyObject;
  readonly sign: (bytes: Uint8Array) => string;
  /** The `ssh-ed25519 <base64>` line of the public key (what `allowed_signers` and `install.sh` take). */
  readonly sshLine: string;
  /** The SSHSIG signature (namespace `otheater-release`) of the bytes, armored, as `ssh-keygen -Y verify` reads it. */
  readonly sshsig: (bytes: Uint8Array, namespace?: string) => string;
}

function sshString(value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** A new Ed25519 pair. */
export function makeKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyBlob = Buffer.concat([
    sshString('ssh-ed25519'),
    sshString(der.subarray(der.length - 32)),
  ]);
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKey,
    sign: (bytes) => sign(null, bytes, privateKey).toString('base64'),
    sshLine: `ssh-ed25519 ${keyBlob.toString('base64')}`,
    sshsig: (bytes, namespace = 'otheater-release') => {
      // The same layout as tools/release/src/sign.ts (PROTOCOL.sshsig), written out here on purpose:
      // the daemon package does not depend on the release tool, and `ssh-keygen` is the judge.
      const digest = createHash('sha512').update(bytes).digest();
      const signed = Buffer.concat([
        Buffer.from('SSHSIG', 'latin1'),
        sshString(namespace),
        sshString(''),
        sshString('sha512'),
        sshString(digest),
      ]);
      const version = Buffer.alloc(4);
      version.writeUInt32BE(1);
      const blob = Buffer.concat([
        Buffer.from('SSHSIG', 'latin1'),
        version,
        sshString(keyBlob),
        sshString(namespace),
        sshString(''),
        sshString('sha512'),
        sshString(
          Buffer.concat([sshString('ssh-ed25519'), sshString(sign(null, signed, privateKey))]),
        ),
      ]);
      const lines = blob.toString('base64').match(/.{1,70}/gu) ?? [];
      return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`;
    },
  };
}

export interface ReleaseSpec {
  readonly version: string;
  readonly channel?: 'stable' | 'beta';
  readonly platform?: string;
  /** The bytes of the executable that is served. */
  readonly exe?: Buffer;
  /** What the manifest says about the executable, when it must differ from the bytes served. */
  readonly sha256?: string;
  readonly size?: number;
  readonly minVersion?: string;
  /** The `expires` of the manifest (ISO). Absent: the manifest has none, like one of an old release. */
  readonly expires?: string;
  readonly name?: string;
  /** Changes the manifest before it is signed. */
  readonly manifest?: Record<string, unknown>;
}

export interface TestRelease {
  readonly manifestBytes: Buffer;
  readonly signature: string;
  /** The SSHSIG signature of the manifest (`manifest.json.sshsig`). */
  readonly sshsig: string;
  readonly exe: Buffer;
  readonly name: string;
  readonly manifest: Record<string, unknown>;
}

export const EXE_BYTES = Buffer.from('#!/bin/sh\necho an executable of the test\n');

export function buildRelease(keys: TestKeys, spec: ReleaseSpec): TestRelease {
  const exe = spec.exe ?? EXE_BYTES;
  const name = spec.name ?? `otheater-${spec.version}-linux-x64`;
  const manifest = {
    schema: 1,
    version: spec.version,
    channel: spec.channel ?? 'stable',
    publishedAt: '2026-11-22T12:00:00Z',
    assets: [
      {
        platform: spec.platform ?? 'linux-x64',
        kind: 'exe',
        name,
        size: spec.size ?? exe.length,
        sha256: spec.sha256 ?? createHash('sha256').update(exe).digest('hex'),
      },
    ],
    ...(spec.minVersion === undefined ? {} : { minVersion: spec.minVersion }),
    ...(spec.expires === undefined ? {} : { expires: spec.expires }),
    ...spec.manifest,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifestBytes,
    signature: keys.sign(manifestBytes),
    sshsig: keys.sshsig(manifestBytes),
    exe,
    name,
    manifest,
  };
}

/** The address of the files of an origin of kind `url` used by the tests. */
export const TEST_ORIGIN = 'https://updates.test/releases/';
export const GITHUB_STABLE = `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/`;
export const GITHUB_LIST = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=30`;

export type Served = Buffer | string | number;

/** An origin in memory: a map from address to what is served, and the list of addresses asked. */
export class FakeOrigin {
  readonly files = new Map<string, Served>();
  readonly asked: string[] = [];
  /** When set, every request fails as a network that is down. */
  down = false;

  /** Serves the three files of a release below `base`. */
  publish(base: string, release: TestRelease): void {
    this.files.set(`${base}manifest.json`, release.manifestBytes);
    this.files.set(`${base}manifest.json.sig`, release.signature);
    this.files.set(`${base}${release.name}`, release.exe);
  }

  readonly fetch: FetchFunction = (input) => {
    const address =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.asked.push(address);
    if (this.down) return Promise.reject(new TypeError('fetch failed'));
    const served = this.files.get(address);
    if (served === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (typeof served === 'number') {
      return Promise.resolve(new Response('error', { status: served }));
    }
    return Promise.resolve(
      new Response(typeof served === 'string' ? served : new Uint8Array(served), { status: 200 }),
    );
  };
}
