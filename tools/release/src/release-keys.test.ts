// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkProductionKey,
  generateEphemeralKey,
  publicPemOf,
  signManifest,
  signManifestSshsig,
  SigningKeyError,
  SSHSIG_NAMESPACE,
  sshPublicKeyLine,
} from './sign.js';

// Every key here is made by the test, at run time: no key, not even a test one, is in the repository.

describe('the ephemeral key', () => {
  it('makes a new pair each time, and the public half belongs to the private one', () => {
    const a = generateEphemeralKey();
    const b = generateEphemeralKey();
    expect(a.privatePem).not.toBe(b.privatePem);
    expect(publicPemOf(a.privatePem)).toBe(a.publicPem);
  });

  it('signs bytes in base64 with a trailing newline', () => {
    const { privatePem } = generateEphemeralKey();
    const signature = signManifest(Buffer.from('{}'), privatePem);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}\n$/);
    // Ed25519 is deterministic: same bytes and key, same signature.
    expect(signManifest(Buffer.from('{}'), privatePem)).toBe(signature);
  });

  it('refuses a key that is not an Ed25519 private key, without echoing it', () => {
    const { publicPem } = generateEphemeralKey();
    expect(() => signManifest(Buffer.from('{}'), publicPem)).toThrow(SigningKeyError);
    expect(() => signManifest(Buffer.from('{}'), 'not a key')).toThrow(/not a private key/);
  });
});

describe('checkProductionKey', () => {
  const placeholder = 'PLACEHOLDER\n';

  it('accepts the secret whose public key is the one of the repository', () => {
    const pair = generateEphemeralKey();
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: pair.publicPem })).toEqual({
      ok: true,
    });
  });

  it('refuses a secret that does not exist or is empty', () => {
    const pair = generateEphemeralKey();
    for (const privatePem of [undefined, '', '   \n']) {
      expect(checkProductionKey({ privatePem, publicPem: pair.publicPem })).toMatchObject({
        ok: false,
        reason: 'secret_missing',
      });
    }
  });

  it('refuses the wrong key: the public key of the secret is not the one of the repository', () => {
    const secret = generateEphemeralKey();
    const repository = generateEphemeralKey();
    expect(
      checkProductionKey({ privatePem: secret.privatePem, publicPem: repository.publicPem }),
    ).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('refuses the PLACEHOLDER of the repository', () => {
    const secret = generateEphemeralKey();
    expect(
      checkProductionKey({ privatePem: secret.privatePem, publicPem: placeholder }),
    ).toMatchObject({ ok: false, reason: 'public_placeholder' });
  });

  it('refuses a missing public file, a public file that is not a key and a secret that is not a key', () => {
    const pair = generateEphemeralKey();
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: undefined })).toMatchObject(
      {
        reason: 'public_missing',
      },
    );
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: 'garbage' })).toMatchObject(
      {
        reason: 'public_invalid',
      },
    );
    expect(checkProductionKey({ privatePem: 'garbage', publicPem: pair.publicPem })).toMatchObject({
      reason: 'secret_invalid',
    });
  });

  it('never puts key material in the message', () => {
    const secret = generateEphemeralKey();
    const repository = generateEphemeralKey();
    const result = checkProductionKey({
      privatePem: secret.privatePem,
      publicPem: repository.publicPem,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('BEGIN');
      expect(result.message).not.toContain(secret.privatePem.split('\n')[1] ?? 'x');
    }
  });
});

// N288: the SSHSIG of the manifest is checked by the real `ssh-keygen -Y verify`, the way install.sh
// does. Without ssh-keygen (or one without -Y) these tests do not run, and say why.
const sshKeygen = spawnSync('ssh-keygen', ['-Y', 'verify'], { encoding: 'utf8', timeout: 20_000 });
const SSH_KEYGEN_VERIFIES =
  sshKeygen.error === undefined &&
  !/invalid option|illegal option|unknown option/iu.test(`${sshKeygen.stdout}${sshKeygen.stderr}`);

describe('the SSHSIG signature', () => {
  it('is armored as ssh-keygen writes it, and the ssh-ed25519 line has the same key', () => {
    const { privatePem, publicPem } = generateEphemeralKey();
    const armored = signManifestSshsig(Buffer.from('{}'), privatePem);
    expect(armored).toMatch(
      /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=]{1,70}\n)+-----END SSH SIGNATURE-----\n$/u,
    );
    expect(sshPublicKeyLine(publicPem)).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/u);
    expect(() => sshPublicKeyLine('not a key')).toThrow(SigningKeyError);
  });

  describe.skipIf(!SSH_KEYGEN_VERIFIES)('with ssh-keygen -Y verify', () => {
    const verify = async (
      manifest: Uint8Array,
      sshsig: string,
      ssh: string,
      namespace: string = SSHSIG_NAMESPACE,
    ): Promise<number | null> => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ot-sshsig-'));
      try {
        const signers = path.join(dir, 'allowed_signers');
        const sigFile = path.join(dir, 'manifest.json.sshsig');
        await writeFile(signers, `otheater namespaces="${SSHSIG_NAMESPACE}" ${ssh}\n`);
        await writeFile(sigFile, sshsig);
        return spawnSync(
          'ssh-keygen',
          ['-Y', 'verify', '-f', signers, '-I', 'otheater', '-n', namespace, '-s', sigFile],
          { input: manifest, timeout: 20_000 },
        ).status;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('accepts the signature of the manifest it signed', async () => {
      const { privatePem, publicPem } = generateEphemeralKey();
      const manifest = Buffer.from('{"schema": 1}\n');
      const sshsig = signManifestSshsig(manifest, privatePem);
      expect(await verify(manifest, sshsig, sshPublicKeyLine(publicPem))).toBe(0);
    });

    it('rejects a manifest changed after it was signed', async () => {
      const { privatePem, publicPem } = generateEphemeralKey();
      const sshsig = signManifestSshsig(Buffer.from('{"schema": 1}\n'), privatePem);
      const status = await verify(
        Buffer.from('{"schema":  1}\n'),
        sshsig,
        sshPublicKeyLine(publicPem),
      );
      expect(status).not.toBe(0);
    });

    it('rejects another key and another namespace', async () => {
      const mine = generateEphemeralKey();
      const other = generateEphemeralKey();
      const manifest = Buffer.from('{}');
      const sshsig = signManifestSshsig(manifest, mine.privatePem);
      expect(await verify(manifest, sshsig, sshPublicKeyLine(other.publicPem))).not.toBe(0);
      const wrong = signManifestSshsig(manifest, mine.privatePem, 'file');
      expect(await verify(manifest, wrong, sshPublicKeyLine(mine.publicPem))).not.toBe(0);
    });
  });
});
