// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterUnavailable, InvalidInput } from '@otheater/core';
import { childEnv } from '../../plugins/sources.js';
import type { Env } from '../../paths.js';
import { SSH_PUBLIC_KEY_PATTERN, WORKFLOW_PACKAGE_SSH_KEYGEN_AUTO } from './config.js';

/**
 * The SSHSIG signature of a workflow package (N298, D5; plan of Phase 11b, P9), checked with
 * `ssh-keygen -Y verify` (the same tool and format as the release signature of `install.sh`, N288).
 * Docs/24 section 9 and the plan fix the tool and the list of trusted keys; the rest here is
 * [proposta]:
 *
 * - the namespace is `otheater-workflow-package` (the release uses `otheater-release`, so a
 *   signature made for one never verifies for the other);
 * - the signature text is read here too (it is a small, documented format), to tell three cases
 *   apart before `ssh-keygen` runs: a signature that is not one (or of another namespace), a
 *   signature of a key the Producer does not trust, and a signature of a trusted key. The decision
 *   `verified` is always `ssh-keygen`'s: this module never accepts a signature by itself;
 * - the allowed signers file holds only the trusted keys, for the one namespace, in a folder that is
 *   removed when the check ends.
 */

/** The SSHSIG namespace of the signature of a workflow package. */
export const WORKFLOW_PACKAGE_SSHSIG_NAMESPACE = 'otheater-workflow-package';

/** What the check of a signature says about a package. */
export const PACKAGE_SIGNATURE_STATES = [
  'verified',
  'invalid',
  'unverified',
  'absent',
  'skipped',
] as const;
export type PackageSignatureState = (typeof PACKAGE_SIGNATURE_STATES)[number];

/**
 * - `verified`: a trusted key signed exactly these bytes;
 * - `invalid`: it is not an SSHSIG, it was made for another namespace, or the trusted key's
 *   signature does not match the bytes;
 * - `unverified`: it could not be checked: the key is not trusted, or `ssh-keygen` is not there;
 * - `absent`: the package has no signature;
 * - `skipped`: `workflows.packages.signature` is `off`.
 */
export interface SignatureCheck {
  readonly state: PackageSignatureState;
  /** The fingerprint (`SHA256:...`) of the key that signed it, when the signature could be read. */
  readonly signer: string | null;
  /** A short text for the Producer. */
  readonly detail: string;
}

const MAX_SIGNATURE_BYTES = 16 * 1024;
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----';
const ARMOR_END = '-----END SSH SIGNATURE-----';

export class SshsigFormatError extends Error {}

/** A reader of the SSH wire format: `uint32` and `string` (a `uint32` length, then the bytes). */
class WireReader {
  readonly #bytes: Buffer;
  #offset = 0;
  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }
  take(length: number): Buffer {
    if (length < 0 || this.#offset + length > this.#bytes.length) {
      throw new SshsigFormatError('the signature is truncated');
    }
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }
  uint32(): number {
    return this.take(4).readUInt32BE(0);
  }
  string(): Buffer {
    return this.take(this.uint32());
  }
  get atEnd(): boolean {
    return this.#offset === this.#bytes.length;
  }
}

export interface ParsedSshsig {
  /** The SSH wire blob of the public key that signed. */
  readonly publicKey: Buffer;
  readonly keyType: string;
  readonly namespace: string;
  readonly hashAlgorithm: string;
}

/** `SHA256:<base64 without padding>` of an SSH public key blob, as `ssh-keygen -l` writes it. */
export function fingerprintOf(publicKeyBlob: Uint8Array): string {
  const digest = createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

/** The type written at the start of an SSH public key blob. */
function blobKeyType(blob: Buffer): string {
  return new WireReader(blob).string().toString('latin1');
}

/**
 * Reads the armored SSHSIG text (layout of PROTOCOL.sshsig of OpenSSH [S]): the blob `"SSHSIG"`,
 * `uint32` version 1, `string` public key, `string` namespace, `string` reserved, `string` hash
 * algorithm and `string` signature. Throws {@link SshsigFormatError} for anything else.
 */
export function parseSshsig(text: string): ParsedSshsig {
  if (Buffer.byteLength(text) > MAX_SIGNATURE_BYTES) {
    throw new SshsigFormatError('the signature is too large');
  }
  const lines = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) {
    throw new SshsigFormatError('it is not an armored SSH signature');
  }
  const body = lines.slice(1, -1).join('');
  if (body === '' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) {
    throw new SshsigFormatError('the armor of the signature is not base64');
  }
  const reader = new WireReader(Buffer.from(body, 'base64'));
  if (reader.take(6).toString('latin1') !== 'SSHSIG') {
    throw new SshsigFormatError('the signature has no SSHSIG magic');
  }
  const version = reader.uint32();
  if (version !== 1) throw new SshsigFormatError(`SSHSIG version ${String(version)} is not known`);
  const publicKey = Buffer.from(reader.string());
  const namespace = reader.string().toString('utf8');
  reader.string();
  const hashAlgorithm = reader.string().toString('latin1');
  reader.string();
  if (!reader.atEnd) throw new SshsigFormatError('the signature has bytes after its end');
  if (hashAlgorithm !== 'sha256' && hashAlgorithm !== 'sha512') {
    throw new SshsigFormatError(`the hash ${hashAlgorithm} is not accepted`);
  }
  return { publicKey, keyType: blobKeyType(publicKey), namespace, hashAlgorithm };
}

/** A key of `trusted_keys`, read: the type and the blob are what is trusted; the comment is dropped. */
export interface TrustedKey {
  readonly type: string;
  readonly blob: Buffer;
  readonly fingerprint: string;
}

/** Reads a line of `trusted_keys`. Throws `InvalidInput` when it is not a public key of a known type. */
export function parseTrustedKey(line: string): TrustedKey {
  const text = line.trim();
  if (!SSH_PUBLIC_KEY_PATTERN.test(text)) {
    throw new InvalidInput('a trusted key is a public key line such as "ssh-ed25519 AAAA..."');
  }
  const [type = '', base64 = ''] = text.split(' ');
  const blob = Buffer.from(base64, 'base64');
  let declared: string;
  try {
    declared = blobKeyType(blob);
  } catch {
    throw new InvalidInput('a trusted key is not a valid SSH public key');
  }
  if (declared !== type) {
    throw new InvalidInput(`a trusted key says ${type} but holds a ${declared} key`);
  }
  return { type, blob, fingerprint: fingerprintOf(blob) };
}

// ---------------------------------------------------------------------------------------------
// Running ssh-keygen

export interface KeygenRun {
  readonly file: string;
  readonly args: readonly string[];
  /** What goes to the standard input: the signed bytes. */
  readonly input: Uint8Array;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface KeygenResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `ssh-keygen` with no shell. Resolves with the exit code (a bad signature is a code, not an
 * error); rejects with `AdapterUnavailable` when the program is not found and with `Error` when it
 * does not finish in time.
 */
export type KeygenRunner = (run: KeygenRun) => Promise<KeygenResult>;

/** The real runner: `execFile`, with the signed bytes on the standard input. */
export const execKeygen: KeygenRunner = (run) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      run.file,
      [...run.args],
      {
        env: { ...run.env },
        timeout: run.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === 'ENOENT') {
          reject(new AdapterUnavailable(`"${run.file}" was not found in PATH`, { cause: error }));
        } else if (failure.killed === true) {
          reject(new Error('ssh-keygen did not finish in time', { cause: error }));
        } else if (typeof failure.code === 'number') {
          resolve({ code: failure.code, stdout, stderr });
        } else {
          reject(new AdapterUnavailable(`ssh-keygen could not run: ${failure.message}`));
        }
      },
    );
    // A program that exits before reading its input closes the pipe: that is the exit code's business.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(Buffer.from(run.input));
  });

export interface VerifyContext {
  readonly trustedKeys: readonly string[];
  /** `workflows.packages.ssh_keygen`: `auto` or the path of the program. */
  readonly sshKeygen: string;
  readonly timeoutMs: number;
  readonly env: Env;
  /** A folder the check may make a subfolder in (removed at the end). */
  readonly tempRoot: string;
  readonly runner?: KeygenRunner | undefined;
  readonly namespace?: string | undefined;
}

const PRINCIPAL = 'otheater-package';

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== '') ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/**
 * Checks `signatureText` against `message`, the bytes the author signed. Never throws for a bad
 * signature: the answer is a {@link SignatureCheck}. Throws `InvalidInput` only for a `trusted_keys`
 * entry that is not a public key (the configuration schema already refuses those).
 */
export async function verifySshsig(
  message: Uint8Array,
  signatureText: string,
  context: VerifyContext,
): Promise<SignatureCheck> {
  const namespace = context.namespace ?? WORKFLOW_PACKAGE_SSHSIG_NAMESPACE;
  let parsed: ParsedSshsig;
  try {
    parsed = parseSshsig(signatureText);
  } catch (error) {
    const reason = error instanceof SshsigFormatError ? error.message : 'it cannot be read';
    return { state: 'invalid', signer: null, detail: `the signature is malformed: ${reason}` };
  }
  const signer = fingerprintOf(parsed.publicKey);
  if (parsed.namespace !== namespace) {
    return {
      state: 'invalid',
      signer,
      detail: `the signature was made for the namespace "${parsed.namespace}", not "${namespace}"`,
    };
  }
  const trusted = context.trustedKeys.map(parseTrustedKey);
  const match = trusted.find((key) => key.blob.equals(parsed.publicKey));
  if (match === undefined) {
    return {
      state: 'unverified',
      signer,
      detail: `the key ${signer} is not in workflows.packages.trusted_keys`,
    };
  }

  const runner = context.runner ?? execKeygen;
  const dir = await mkdtemp(join(context.tempRoot, 'sig-'));
  try {
    const allowed = join(dir, 'allowed_signers');
    const signatureFile = join(dir, 'package.sshsig');
    await writeFile(
      allowed,
      `${PRINCIPAL} namespaces="${namespace}" ${match.type} ${match.blob.toString('base64')}\n`,
    );
    await writeFile(signatureFile, signatureText);
    const result = await runner({
      file:
        context.sshKeygen === WORKFLOW_PACKAGE_SSH_KEYGEN_AUTO ? 'ssh-keygen' : context.sshKeygen,
      args: ['-Y', 'verify', '-f', allowed, '-I', PRINCIPAL, '-n', namespace, '-s', signatureFile],
      input: message,
      env: childEnv(context.env, 'git'),
      timeoutMs: context.timeoutMs,
    });
    if (result.code === 0 && result.stdout.startsWith('Good "')) {
      return { state: 'verified', signer, detail: `signed by ${signer}` };
    }
    const why = firstLine(result.stderr) || firstLine(result.stdout) || 'it does not match';
    return {
      state: 'invalid',
      signer,
      detail: `ssh-keygen does not accept the signature (${why})`,
    };
  } catch (error) {
    if (error instanceof AdapterUnavailable) {
      return {
        state: 'unverified',
        signer,
        detail: `ssh-keygen is not available, so the signature of ${signer} was not checked`,
      };
    }
    const why = error instanceof Error ? error.message : String(error);
    return { state: 'unverified', signer, detail: `the signature could not be checked: ${why}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
