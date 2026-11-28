// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { AdapterUnavailable, InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateTestKey,
  removeTempFolders,
  signSshsig,
  tempFolder,
} from './packages.test-support.js';
import {
  fingerprintOf,
  parseSshsig,
  parseTrustedKey,
  SshsigFormatError,
  verifySshsig,
  WORKFLOW_PACKAGE_SSHSIG_NAMESPACE,
  type KeygenRunner,
  type VerifyContext,
} from './sshsig.js';

afterEach(removeTempFolders);

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    // `ssh-keygen -?` exits with a code when it prints its usage; only a missing program is a no.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const MESSAGE = Buffer.from('id: review\nversion: 1.0.0\n');

async function context(
  trustedKeys: readonly string[],
  extra: Partial<VerifyContext> = {},
): Promise<VerifyContext> {
  return {
    trustedKeys,
    sshKeygen: 'auto',
    timeoutMs: 10_000,
    env: { PATH: process.env.PATH },
    tempRoot: await tempFolder(),
    ...extra,
  };
}

describe('parseSshsig and parseTrustedKey', () => {
  it('reads the namespace, the hash and the key of a signature', () => {
    const key = generateTestKey();
    const parsed = parseSshsig(signSshsig(MESSAGE, key, 'ns', 'sha256'));
    expect(parsed).toMatchObject({
      namespace: 'ns',
      hashAlgorithm: 'sha256',
      keyType: 'ssh-ed25519',
    });
    expect(fingerprintOf(parsed.publicKey)).toBe(parseTrustedKey(key.publicLine).fingerprint);
    expect(fingerprintOf(parsed.publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('refuses text that is not an SSHSIG', () => {
    const key = generateTestKey();
    const good = signSshsig(MESSAGE, key);
    for (const text of [
      '',
      'hello',
      good.replace('BEGIN', 'START'),
      '-----BEGIN SSH SIGNATURE-----\n!!!!\n-----END SSH SIGNATURE-----\n',
      '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n',
      `${good}${'A'.repeat(20_000)}`,
    ]) {
      expect(() => parseSshsig(text)).toThrow(SshsigFormatError);
    }
  });

  it('refuses a trusted key that is not a key, or whose type does not match', () => {
    const key = generateTestKey();
    expect(parseTrustedKey(`${key.publicLine} a comment`).type).toBe('ssh-ed25519');
    expect(() => parseTrustedKey('hello')).toThrow(InvalidInput);
    const blob = key.publicLine.split(' ')[1] ?? '';
    expect(() => parseTrustedKey(`ssh-rsa ${blob}`)).toThrow(/holds a ssh-ed25519/);
  });
});

describe('verifySshsig, without running ssh-keygen', () => {
  it('says invalid for a malformed signature and for another namespace', async () => {
    const key = generateTestKey();
    const malformed = await verifySshsig(MESSAGE, 'nonsense', await context([key.publicLine]));
    expect(malformed).toMatchObject({ state: 'invalid', signer: null });
    const release = signSshsig(MESSAGE, key, 'otheater-release');
    const other = await verifySshsig(MESSAGE, release, await context([key.publicLine]));
    expect(other.state).toBe('invalid');
    expect(other.detail).toMatch(/otheater-release/);
  });

  it('says unverified for a key that is not trusted', async () => {
    const signer = generateTestKey();
    const other = generateTestKey();
    const check = await verifySshsig(
      MESSAGE,
      signSshsig(MESSAGE, signer),
      await context([other.publicLine]),
    );
    expect(check.state).toBe('unverified');
    expect(check.signer).toBe(parseTrustedKey(signer.publicLine).fingerprint);
    expect(check.detail).toMatch(/trusted_keys/);
    const none = await verifySshsig(MESSAGE, signSshsig(MESSAGE, signer), await context([]));
    expect(none.state).toBe('unverified');
  });

  it('says unverified when there is no ssh-keygen, and when it does not finish', async () => {
    const key = generateTestKey();
    const text = signSshsig(MESSAGE, key);
    const missing: KeygenRunner = () => Promise.reject(new AdapterUnavailable('not found'));
    const without = await verifySshsig(
      MESSAGE,
      text,
      await context([key.publicLine], { runner: missing }),
    );
    expect(without.state).toBe('unverified');
    expect(without.detail).toMatch(/not available/);
    const slow: KeygenRunner = () => Promise.reject(new Error('did not finish in time'));
    const timedOut = await verifySshsig(
      MESSAGE,
      text,
      await context([key.publicLine], { runner: slow }),
    );
    expect(timedOut.state).toBe('unverified');
  });

  it('never accepts on its own: a runner that does not say Good is invalid', async () => {
    const key = generateTestKey();
    const text = signSshsig(MESSAGE, key);
    const liar: KeygenRunner = () => Promise.resolve({ code: 0, stdout: 'ok\n', stderr: '' });
    const refused = await verifySshsig(
      MESSAGE,
      text,
      await context([key.publicLine], { runner: liar }),
    );
    expect(refused.state).toBe('invalid');
    const failing: KeygenRunner = () =>
      Promise.resolve({ code: 255, stdout: '', stderr: 'Signature verification failed\n' });
    const failed = await verifySshsig(
      MESSAGE,
      text,
      await context([key.publicLine], { runner: failing }),
    );
    expect(failed.state).toBe('invalid');
    expect(failed.detail).toMatch(/Signature verification failed/);
  });

  it('passes the message on the input, the namespace and the allowed signers to the program', async () => {
    const key = generateTestKey();
    let seen: Parameters<KeygenRunner>[0] | undefined;
    const runner: KeygenRunner = (run) => {
      seen = run;
      return Promise.resolve({ code: 0, stdout: 'Good "x" signature\n', stderr: '' });
    };
    const check = await verifySshsig(
      MESSAGE,
      signSshsig(MESSAGE, key),
      await context([key.publicLine], { runner }),
    );
    expect(check.state).toBe('verified');
    expect(Buffer.from(seen?.input ?? []).equals(MESSAGE)).toBe(true);
    expect(seen?.args).toEqual(
      expect.arrayContaining(['-Y', 'verify', '-n', WORKFLOW_PACKAGE_SSHSIG_NAMESPACE]),
    );
    expect(seen?.file).toBe('ssh-keygen');
  });

  it('removes its temporary folder, whatever the answer', async () => {
    const key = generateTestKey();
    const ctx = await context([key.publicLine], {
      runner: () => Promise.reject(new Error('boom')),
    });
    await verifySshsig(MESSAGE, signSshsig(MESSAGE, key), ctx);
    expect(await readdir(ctx.tempRoot)).toEqual([]);
  });
});

describe.skipIf(!hasSshKeygen())('verifySshsig with the real ssh-keygen', () => {
  it('verifies what a trusted key signed', async () => {
    const key = generateTestKey();
    const check = await verifySshsig(
      MESSAGE,
      signSshsig(MESSAGE, key),
      await context([key.publicLine]),
    );
    expect(check).toMatchObject({ state: 'verified' });
    expect(check.signer).toBe(parseTrustedKey(key.publicLine).fingerprint);
  });

  it('verifies a signature made with sha256 too', async () => {
    const key = generateTestKey();
    const check = await verifySshsig(
      MESSAGE,
      signSshsig(MESSAGE, key, WORKFLOW_PACKAGE_SSHSIG_NAMESPACE, 'sha256'),
      await context([key.publicLine]),
    );
    expect(check.state).toBe('verified');
  });

  it('refuses a message that changed after it was signed', async () => {
    const key = generateTestKey();
    const text = signSshsig(MESSAGE, key);
    const check = await verifySshsig(
      Buffer.from('id: review\nversion: 9.9.9\n'),
      text,
      await context([key.publicLine]),
    );
    expect(check.state).toBe('invalid');
  });

  it('says unverified when the program is not where ssh_keygen points', async () => {
    const key = generateTestKey();
    const check = await verifySshsig(
      MESSAGE,
      signSshsig(MESSAGE, key),
      await context([key.publicLine], { sshKeygen: '/nonexistent/ssh-keygen' }),
    );
    expect(check.state).toBe('unverified');
  });
});
