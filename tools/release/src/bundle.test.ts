// SPDX-License-Identifier: MPL-2.0
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTarget } from './build.js';
import { bundleDefines, readUpdatePublicKey } from './bundle.js';
import { parseReleaseConfig } from './config.js';
import { repoRoot } from './resolve.js';
import { hostTarget } from './targets.js';

const folders: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ot-bundle-'));
  folders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function publicPem(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
}

describe('the define of the update public key (P8a, finding 1)', () => {
  it('bundleDefines carries __OT_UPDATE_PUBLIC_KEY__ as the JSON text of the key', () => {
    const pem = publicPem();
    const defines = bundleDefines('1.2.3', undefined, pem);
    // If this define disappears the daemon in the executable has no key: keep the test failing then.
    expect(defines).toHaveProperty('__OT_UPDATE_PUBLIC_KEY__');
    expect(JSON.parse(defines.__OT_UPDATE_PUBLIC_KEY__ ?? '')).toBe(pem);
    expect(defines.__OT_BUILD_VERSION__).toBe('"1.2.3"');
  });

  it('is the name the daemon reads', () => {
    const daemon = readFileSync(
      path.join(repoRoot(), 'packages', 'daemon', 'src', 'updates', 'key.ts'),
      'utf8',
    );
    expect(daemon).toContain('__OT_UPDATE_PUBLIC_KEY__');
  });

  it('readUpdatePublicKey takes a valid Ed25519 key and the PLACEHOLDER', () => {
    const dir = temp();
    const good = path.join(dir, 'good.pem');
    const pem = publicPem();
    writeFileSync(good, pem);
    expect(readUpdatePublicKey(good)).toBe(pem);
    const placeholder = path.join(dir, 'placeholder.pem');
    writeFileSync(placeholder, 'PLACEHOLDER\n');
    expect(readUpdatePublicKey(placeholder)).toBe('PLACEHOLDER\n');
  });

  it('readUpdatePublicKey refuses a missing file, an empty one and a key of another type', () => {
    const dir = temp();
    expect(() => readUpdatePublicKey(path.join(dir, 'nope.pem'))).toThrow(/missing/u);
    const empty = path.join(dir, 'empty.pem');
    writeFileSync(empty, '');
    expect(() => readUpdatePublicKey(empty)).toThrow(/neither the PLACEHOLDER/u);
    const rsa = path.join(dir, 'rsa.pem');
    writeFileSync(
      rsa,
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
    );
    expect(() => readUpdatePublicKey(rsa)).toThrow(/neither the PLACEHOLDER/u);
    const junk = path.join(dir, 'junk.pem');
    writeFileSync(junk, 'not a key');
    expect(() => readUpdatePublicKey(junk)).toThrow(/neither the PLACEHOLDER/u);
  });

  it('a release build without the key file fails before it writes anything (no fallback)', async () => {
    const target = hostTarget();
    if (target === undefined) return;
    const dir = temp();
    const out = path.join(dir, 'out');
    await expect(
      buildTarget({
        root: repoRoot(),
        target,
        config: parseReleaseConfig({}),
        outDir: out,
        publicKeyFile: path.join(dir, 'absent.pem'),
      }),
    ).rejects.toThrow(/update public key file is missing/u);
    expect(() => readFileSync(path.join(out, target, 'ot.cjs'))).toThrow();
  });
});
