// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, PermissionDenied, SecretKeySchema } from '@otheater/core';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import { ScryptParamsSchema, type ScryptParams } from './config.js';

/**
 * On-disk format [proposta]: one JSON document, UTF-8.
 *
 * ```json
 * { "format": "otheater-vault-file", "version": 1,
 *   "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64, 32 bytes>" },
 *   "cipher": { "name": "aes-256-gcm", "iv": "<base64, 12 bytes>", "tag": "<base64, 16 bytes>" },
 *   "data": "<base64 ciphertext>" }
 * ```
 *
 * `data` is the whole secret map, `{"secrets": {"<key>": "<value>"}}`, encrypted as one unit, so
 * neither the values nor the key names nor their number show in clear (only the total size does:
 * no padding). The header (format, version, KDF name and parameters, salt) is authenticated as
 * GCM additional data, so changing any of it fails the tag. Every write uses a new random IV
 * under the same derived key (random 96-bit IVs stay safe for far more writes than a vault sees).
 */
export const FILE_FORMAT = 'otheater-vault-file';
export const FILE_VERSION = 1;
/** [proposta] A vault file larger than this is refused before it is read. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const FileSchema = z.strictObject({
  format: z.literal(FILE_FORMAT),
  version: z.literal(FILE_VERSION),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: ScryptParamsSchema.shape.N.unwrap(),
    r: ScryptParamsSchema.shape.r.unwrap(),
    p: ScryptParamsSchema.shape.p.unwrap(),
    salt: base64,
  }),
  cipher: z.strictObject({ name: z.literal('aes-256-gcm'), iv: base64, tag: base64 }),
  data: base64,
});

const PlaintextSchema = z.strictObject({ secrets: z.record(z.string(), z.string()) });

/** A vault file after structural validation, with the binary fields decoded. */
export interface ParsedFile {
  readonly kdf: ScryptParams;
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly data: Buffer;
}

/** The corruption messages carry no file content: only which part is wrong. */
function corrupted(reason: string, cause?: unknown): AdapterUnavailable {
  return new AdapterUnavailable(
    `The vault file is corrupted or not a vault file (${reason}). Nothing was changed or deleted; restore a backup or choose another path.`,
    cause === undefined ? undefined : { cause },
  );
}

function decodeBase64(text: string, field: string, bytes?: number): Buffer {
  const buffer = Buffer.from(text, 'base64');
  if (buffer.toString('base64') !== text) throw corrupted(`${field} is not canonical base64`);
  if (bytes !== undefined && buffer.length !== bytes) throw corrupted(`${field} has a wrong size`);
  return buffer;
}

/** Parses and validates the text of a vault file. Throws `AdapterUnavailable` on any defect. */
export function parseFile(text: string): ParsedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw corrupted('not valid JSON', error);
  }
  if (typeof json !== 'object' || json === null || !('format' in json)) {
    throw corrupted('no format marker');
  }
  if (json.format !== FILE_FORMAT) throw corrupted('unknown format');
  const version = 'version' in json ? json.version : undefined;
  if (version !== FILE_VERSION) {
    throw new AdapterUnavailable(
      `The vault file has version ${typeof version === 'number' ? String(version) : 'unknown'}, but this build reads only version ${String(FILE_VERSION)}. Nothing was changed or deleted; use a build that supports it.`,
    );
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw corrupted(`invalid fields: ${where}`);
  }
  const file = parsed.data;
  return {
    kdf: { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p },
    salt: decodeBase64(file.kdf.salt, 'kdf.salt', SALT_BYTES),
    iv: decodeBase64(file.cipher.iv, 'cipher.iv', IV_BYTES),
    tag: decodeBase64(file.cipher.tag, 'cipher.tag', TAG_BYTES),
    data: decodeBase64(file.data, 'data'),
  };
}

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** Memory scrypt needs is about 128 * N * r bytes; `maxmem` is set just above that. */
function maxmemFor({ N, r, p }: ScryptParams): number {
  return 128 * r * (N + p + 2) + 2 ** 20;
}

/** scrypt on the libuv thread pool (does not block the event loop). */
export function deriveKey(password: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** Additional authenticated data: everything in the header that decides how to decrypt. */
function aadFor(kdf: ScryptParams, salt: Buffer): Buffer {
  return Buffer.from(
    [
      FILE_FORMAT,
      String(FILE_VERSION),
      'scrypt',
      kdf.N,
      kdf.r,
      kdf.p,
      salt.toString('base64'),
    ].join('\n'),
    'utf8',
  );
}

/** Encrypts the map and returns the text of the file. Fresh random IV on every call. */
export function encryptFile(
  key: Buffer,
  salt: Buffer,
  kdf: ScryptParams,
  secrets: ReadonlyMap<string, Buffer>,
): string {
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of secrets) record[name] = value.toString('utf8');
  const plain = Buffer.from(JSON.stringify({ secrets: record }), 'utf8');
  const iv = randomBytes(IV_BYTES);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadFor(kdf, salt));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const file = {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      data: data.toString('base64'),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  } finally {
    plain.fill(0);
  }
}

/**
 * Decrypts a parsed file with `key` and returns the secret map (values as zero-able buffers).
 * A failed tag (wrong password, or file changed) throws `PermissionDenied`; a payload that
 * decrypts but is not what we wrote throws `AdapterUnavailable` (corrupted).
 */
export function decryptFile(file: ParsedFile, key: Buffer): Map<string, Buffer> {
  const decipher = createDecipheriv('aes-256-gcm', key, file.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadFor(file.kdf, file.salt));
  decipher.setAuthTag(file.tag);
  const head = decipher.update(file.data);
  let plain: Buffer;
  try {
    plain = Buffer.concat([head, decipher.final()]);
  } catch (error) {
    head.fill(0);
    throw new PermissionDenied(
      'Wrong master password, or the vault file was modified (the authentication tag does not match).',
      { cause: error },
    );
  }
  head.fill(0);
  try {
    return secretsFrom(plain);
  } finally {
    plain.fill(0);
  }
}

function secretsFrom(plain: Buffer): Map<string, Buffer> {
  let json: unknown;
  try {
    json = JSON.parse(plain.toString('utf8'));
  } catch (error) {
    throw corrupted('the decrypted payload is not valid JSON', error);
  }
  const parsed = PlaintextSchema.safeParse(json);
  if (!parsed.success) throw corrupted('the decrypted payload has an unexpected shape');
  const secrets = new Map<string, Buffer>();
  for (const [name, value] of Object.entries(parsed.data.secrets)) {
    if (!SecretKeySchema.safeParse(name).success) {
      for (const buffer of secrets.values()) buffer.fill(0);
      throw corrupted('the decrypted payload holds an invalid key');
    }
    secrets.set(name, Buffer.from(value, 'utf8'));
  }
  return secrets;
}
