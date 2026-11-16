// SPDX-License-Identifier: MPL-2.0
import { Secret, SECRET_VAULT_PORT_VERSION } from '@otheater/core';
import { describeSecretVaultConformance } from '@otheater/sdk';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileVault,
  EncryptedFileVaultConfigSchema,
  encryptedFileVaultAdapter,
  MIN_SCRYPT_N,
  type EncryptedFileVaultConfigInput,
} from './index.js';

/** Cheapest accepted cost: the tests derive many keys. */
const FAST = { N: MIN_SCRYPT_N, r: 8, p: 1 } as const;
const PASSWORD = new Secret('correct horse battery staple');
const posix = process.platform !== 'win32';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-vault-file-'));
});

afterEach(async () => {
  // Directories made read-only by a test must be writable again to be removed.
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function config(
  overrides: Partial<EncryptedFileVaultConfigInput> = {},
): EncryptedFileVaultConfigInput {
  return { path: join(root, 'state', 'vault.json'), scrypt: FAST, ...overrides };
}

async function unlocked(overrides: Partial<EncryptedFileVaultConfigInput> = {}) {
  const vault = new EncryptedFileVault(config(overrides));
  await vault.unlock(PASSWORD);
  return vault;
}

/** The parts of the vault file the tests edit. */
interface FileJson {
  kdf: { N: number; salt: string };
  cipher: { iv: string; tag: string };
  data: string;
}

/** Files in the vault directory, to catch temporaries left behind. */
async function directoryEntries(): Promise<string[]> {
  return (await readdir(join(root, 'state'))).sort();
}

describeSecretVaultConformance('EncryptedFileVault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-vault-conf-'));
  const vault = new EncryptedFileVault({ path: join(dir, 'vault.json'), scrypt: FAST });
  await vault.unlock(PASSWORD);
  return {
    vault,
    lock: () => vault.lock(),
    unlock: () => vault.unlock(PASSWORD),
    dispose: async () => {
      await vault.lock();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe('EncryptedFileVault', () => {
  it('starts locked and rejects every operation with VAULT_LOCKED', async () => {
    const vault = new EncryptedFileVault(config());
    expect(vault.isLocked).toBe(true);
    await expect(vault.get('k')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(vault.set('k', new Secret('v'))).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(vault.delete('k')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(vault.list()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    // Nothing was created by the failed calls.
    await expect(stat(join(root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unlock creates the file (and its directory) when it does not exist', async () => {
    const vault = await unlocked();
    expect(vault.isLocked).toBe(false);
    expect(await directoryEntries()).toEqual(['vault.json']);
    expect(await vault.list()).toEqual([]);
  });

  it('persists across instances', async () => {
    const first = await unlocked();
    await first.set('profile/a/api-key', new Secret('sk-one'));
    await first.set('profile/b/api-key', new Secret('çã 🔑\n"quoted"'));
    await first.delete('profile/a/api-key');
    await first.lock();

    const second = await unlocked();
    expect(await second.list()).toEqual(['profile/b/api-key']);
    expect((await second.get('profile/b/api-key'))?.reveal()).toBe('çã 🔑\n"quoted"');
    expect(await second.get('profile/a/api-key')).toBeUndefined();
  });

  it('a wrong password fails with PERMISSION_DENIED, leaves the vault locked and the file intact', async () => {
    const vault = await unlocked();
    await vault.set('k', new Secret('v'));
    await vault.lock();
    const before = await readFile(config().path);

    const other = new EncryptedFileVault(config());
    const error: unknown = await other
      .unlock(new Secret('wrong password'))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(String(error)).not.toContain('wrong password');
    expect(other.isLocked).toBe(true);
    await expect(other.get('k')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    expect(await readFile(config().path)).toEqual(before);

    await other.unlock(PASSWORD); // the right one still works
    expect((await other.get('k'))?.reveal()).toBe('v');
  });

  it('unlock on an unlocked vault only verifies the password', async () => {
    const vault = await unlocked();
    await vault.set('k', new Secret('v'));
    await expect(vault.unlock(new Secret('nope'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(vault.isLocked).toBe(false);
    await expect(vault.unlock(PASSWORD)).resolves.toBeUndefined();
    expect((await vault.get('k'))?.reveal()).toBe('v');
  });

  it('rejects an empty password with INVALID_INPUT and writes nothing', async () => {
    const vault = new EncryptedFileVault(config());
    await expect(vault.unlock(new Secret(''))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(vault.isLocked).toBe(true);
    await expect(stat(config().path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(posix)('the file is 0600 and the directory it created is 0700', async () => {
    const vault = await unlocked();
    await vault.set('k', new Secret('v'));
    expect((await stat(config().path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'state'))).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('does not change the mode of a directory that already existed', async () => {
    await mkdir(join(root, 'state'), { mode: 0o755 });
    await chmod(join(root, 'state'), 0o755);
    await unlocked();
    expect((await stat(join(root, 'state'))).mode & 0o777).toBe(0o755);
    expect((await stat(config().path)).mode & 0o777).toBe(0o600);
  });

  it('the file holds neither the values nor the key names in clear', async () => {
    const vault = await unlocked();
    const value = 'sk-live-very-recognisable-value-0123456789';
    await vault.set('profile/minimax-main/api-key', new Secret(value));
    const raw = await readFile(config().path);
    const text = raw.toString('utf8');
    for (const needle of [value, 'minimax', 'api-key', 'profile/', 'sk-live']) {
      expect(text).not.toContain(needle);
      expect(raw.includes(Buffer.from(needle))).toBe(false);
    }
    // Not even as base64 of the plain JSON.
    expect(text).not.toContain(Buffer.from(value).toString('base64'));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ format: 'otheater-vault-file', version: 1 });
    expect(parsed.kdf).toMatchObject({ name: 'scrypt', ...FAST });
  });

  it('uses a new IV (and so a new ciphertext) on every write', async () => {
    const vault = await unlocked();
    const ivs = new Set<string>();
    const blobs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await vault.set('k', new Secret('same value every time'));
      const file = JSON.parse(await readFile(config().path, 'utf8')) as {
        cipher: { iv: string };
        data: string;
      };
      ivs.add(file.cipher.iv);
      blobs.add(file.data);
    }
    expect(ivs.size).toBe(5);
    expect(blobs.size).toBe(5);
  });

  it('keeps the salt across writes and uses the cost the file was created with', async () => {
    const vault = await unlocked();
    const read = async () =>
      (JSON.parse(await readFile(config().path, 'utf8')) as { kdf: Record<string, unknown> }).kdf;
    const first = await read();
    await vault.set('k', new Secret('v'));
    expect(await read()).toEqual(first);
    await vault.lock();

    // Reopened with another configured cost: the file's own parameters win.
    const reopened = new EncryptedFileVault(
      config({ scrypt: { N: MIN_SCRYPT_N * 2, r: 8, p: 1 } }),
    );
    await reopened.unlock(PASSWORD);
    await reopened.set('k2', new Secret('v2'));
    expect(await read()).toEqual(first);
  });

  describe('a modified file', () => {
    async function mutate(change: (file: FileJson) => void): Promise<void> {
      const vault = await unlocked();
      await vault.set('k', new Secret('v'));
      await vault.lock();
      const file = JSON.parse(await readFile(config().path, 'utf8')) as FileJson;
      change(file);
      await writeFile(config().path, JSON.stringify(file));
    }

    function flip(text: string): string {
      const bytes = Buffer.from(text, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      return bytes.toString('base64');
    }

    it('fails the GCM tag when the ciphertext changes', async () => {
      await mutate((f) => {
        f.data = flip(f.data);
      });
      await expect(new EncryptedFileVault(config()).unlock(PASSWORD)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    });

    it('fails the GCM tag when the tag, the IV or the salt change', async () => {
      for (const edit of [
        (f: FileJson) => (f.cipher.tag = flip(f.cipher.tag)),
        (f: FileJson) => (f.cipher.iv = flip(f.cipher.iv)),
        (f: FileJson) => (f.kdf.salt = flip(f.kdf.salt)),
      ]) {
        await rm(join(root, 'state'), { recursive: true, force: true });
        await mutate(edit);
        await expect(new EncryptedFileVault(config()).unlock(PASSWORD)).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        });
      }
    });

    it('fails when the KDF parameters are changed (they are authenticated)', async () => {
      await mutate((f) => {
        f.kdf.N = MIN_SCRYPT_N * 2;
      });
      await expect(new EncryptedFileVault(config()).unlock(PASSWORD)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    });

    it('is never rewritten or deleted by a failed unlock', async () => {
      await mutate((f) => {
        f.data = flip(f.data);
      });
      const before = await readFile(config().path);
      await new EncryptedFileVault(config()).unlock(PASSWORD).catch(() => undefined);
      expect(await readFile(config().path)).toEqual(before);
      expect(await directoryEntries()).toEqual(['vault.json']);
    });
  });

  describe('a corrupted file or an unknown version', () => {
    async function expectUnavailable(content: string, message: RegExp): Promise<void> {
      await mkdir(join(root, 'state'), { recursive: true });
      await writeFile(config().path, content);
      const vault = new EncryptedFileVault(config());
      const error: unknown = await vault.unlock(PASSWORD).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      expect((error as Error).message).toMatch(message);
      expect(vault.isLocked).toBe(true);
      // Left exactly as found: never repaired, truncated or deleted.
      expect(await readFile(config().path, 'utf8')).toBe(content);
      expect(await directoryEntries()).toEqual(['vault.json']);
    }

    it('rejects text that is not JSON', async () => {
      await expectUnavailable('this is not json', /corrupted/);
    });

    it('rejects an empty file', async () => {
      await expectUnavailable('', /corrupted/);
    });

    it('rejects JSON of another format', async () => {
      await expectUnavailable('{"hello":"world"}', /corrupted/);
      await expectUnavailable('[1,2,3]', /corrupted/);
    });

    it('rejects an unknown version, naming it', async () => {
      await expectUnavailable(
        JSON.stringify({ format: 'otheater-vault-file', version: 2 }),
        /version 2.*only version 1/,
      );
    });

    it('rejects missing or malformed fields without echoing their content', async () => {
      await expectUnavailable(
        JSON.stringify({ format: 'otheater-vault-file', version: 1, kdf: {}, cipher: {}, data: 7 }),
        /invalid fields/,
      );
    });

    it('rejects out-of-bounds KDF parameters (no memory bomb from a hostile file)', async () => {
      const vault = await unlocked();
      await vault.lock();
      const file = JSON.parse(await readFile(config().path, 'utf8')) as {
        kdf: Record<string, unknown>;
      };
      file.kdf.N = 2 ** 30;
      await expectUnavailable(JSON.stringify(file), /kdf\.N/);
    });

    it('rejects a field of the wrong size', async () => {
      const vault = await unlocked();
      await vault.lock();
      const file = JSON.parse(await readFile(config().path, 'utf8')) as {
        cipher: Record<string, unknown>;
      };
      file.cipher.iv = Buffer.alloc(8).toString('base64');
      await expectUnavailable(JSON.stringify(file), /cipher\.iv/);
    });
  });

  describe('writes', () => {
    it('are atomic: only the vault file remains in the directory', async () => {
      const vault = await unlocked();
      for (let i = 0; i < 10; i++) await vault.set(`key/${String(i)}`, new Secret(`v${String(i)}`));
      await vault.delete('key/3');
      expect(await directoryEntries()).toEqual(['vault.json']);
    });

    it('are serialized: concurrent calls all land and the file stays valid', async () => {
      const vault = await unlocked();
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 25; i++)
        writes.push(vault.set(`k/${String(i)}`, new Secret(`v${String(i)}`)));
      writes.push(vault.delete('k/7'));
      await Promise.all(writes);
      expect(await directoryEntries()).toEqual(['vault.json']);
      await vault.lock();

      const reopened = await unlocked();
      const keys = await reopened.list();
      expect(keys).toHaveLength(24);
      expect(keys).not.toContain('k/7');
      expect((await reopened.get('k/24'))?.reveal()).toBe('v24');
    });

    it('a get queued after a set sees it', async () => {
      const vault = await unlocked();
      const set = vault.set('k', new Secret('new'));
      const get = vault.get('k');
      await set;
      expect((await get)?.reveal()).toBe('new');
    });

    it('lock waits for pending writes, then later calls are locked', async () => {
      const vault = await unlocked();
      const set = vault.set('k', new Secret('v'));
      const lock = vault.lock();
      const after = vault.get('k');
      await set;
      await lock;
      await expect(after).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
      const reopened = await unlocked();
      expect((await reopened.get('k'))?.reveal()).toBe('v');
    });

    it.runIf(posix && process.getuid?.() !== 0)(
      'a failed write leaves memory, the file and the directory as they were',
      async () => {
        const vault = await unlocked();
        await vault.set('k', new Secret('old'));
        const before = await readFile(config().path);

        await chmod(join(root, 'state'), 0o500); // cannot create the temporary file
        await expect(vault.set('k', new Secret('new'))).rejects.toMatchObject({
          code: 'ADAPTER_UNAVAILABLE',
        });
        await expect(vault.delete('k')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
        await chmod(join(root, 'state'), 0o700);

        expect((await vault.get('k'))?.reveal()).toBe('old');
        expect(await readFile(config().path)).toEqual(before);
        expect(await directoryEntries()).toEqual(['vault.json']);
        await vault.set('k', new Secret('new')); // works again
        expect((await vault.get('k'))?.reveal()).toBe('new');
      },
    );
  });

  describe('lock', () => {
    it('drops the secrets: after lock a new unlock is needed, and the password is checked', async () => {
      const vault = await unlocked();
      await vault.set('k', new Secret('v'));
      await vault.lock();
      expect(vault.isLocked).toBe(true);
      await expect(vault.get('k')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
      await expect(vault.unlock(new Secret('wrong'))).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect(vault.isLocked).toBe(true);
      await vault.unlock(PASSWORD);
      expect((await vault.get('k'))?.reveal()).toBe('v');
    });

    it('is idempotent', async () => {
      const vault = new EncryptedFileVault(config());
      await vault.lock();
      await vault.lock();
      expect(vault.isLocked).toBe(true);
    });
  });

  describe('errors never carry secret values', () => {
    it('neither messages nor causes show the password or a stored value', async () => {
      const vault = await unlocked();
      const value = 'sk-must-not-appear-anywhere';
      await vault.set('k', new Secret(value));
      await vault.lock();
      const password = 'my master password 12345';
      const error = await vault.unlock(new Secret(password)).catch((e: unknown) => e);
      const dump = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error);
      expect(dump).not.toContain(password);
      expect(dump).not.toContain(value);
    });
  });

  describe('config', () => {
    it('fills the secure default cost', () => {
      const parsed = EncryptedFileVaultConfigSchema.parse({ path: '/x/vault.json' });
      expect(parsed.scrypt).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    });

    it('accepts a partial scrypt block', () => {
      const parsed = EncryptedFileVaultConfigSchema.parse({
        path: '/x/vault.json',
        scrypt: { N: 2 ** 15 },
      });
      expect(parsed.scrypt).toEqual({ N: 2 ** 15, r: 8, p: 1 });
    });

    it('rejects a cost below the minimum, a non power of two, and unknown keys', () => {
      const bad: unknown[] = [
        { path: 'x', scrypt: { N: 2 ** 13 } },
        { path: 'x', scrypt: { N: 20_000 } },
        { path: 'x', scrypt: { N: 2 ** 21 } },
        { path: 'x', scrypt: { r: 4 } },
        { path: 'x', scrypt: { p: 0 } },
        { path: '' },
        {},
        { path: 'x', extra: true },
      ];
      for (const input of bad) {
        expect(EncryptedFileVaultConfigSchema.safeParse(input).success).toBe(false);
      }
    });

    it('the constructor reports a bad config as INVALID_INPUT', () => {
      expect(() => new EncryptedFileVault({ path: 'x', scrypt: { N: 2 ** 10 } })).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
      );
    });

    it('declares the SecretVault port with a range that covers its version', () => {
      expect(encryptedFileVaultAdapter).toEqual({
        id: 'encrypted-file',
        implements: { port: 'SecretVault', range: `^${SECRET_VAULT_PORT_VERSION}` },
      });
      expect(encryptedFileVaultAdapter.implements.range).toBe('^0.1.0');
    });
  });
});
