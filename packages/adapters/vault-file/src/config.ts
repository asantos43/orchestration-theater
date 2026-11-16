// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/** Default scrypt cost (N = 2^17, r = 8, p = 1: about 128 MiB and a few hundred ms). */
export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;

/** [proposta] Lowest accepted N: 2^14 is 16 MiB at r = 8; below that scrypt is no password hash. */
export const MIN_SCRYPT_N = 2 ** 14;
/** [proposta] Highest accepted N (1 GiB at r = 8): a bound for what a hostile file may demand. */
export const MAX_SCRYPT_N = 2 ** 20;

const isPowerOfTwo = (n: number): boolean => (n & (n - 1)) === 0;

/**
 * Parameters of scrypt. The same bounds apply to the config and to the parameters read back from
 * a vault file, so a tampered file cannot make the daemon allocate unbounded memory.
 */
export const ScryptParamsSchema = z.strictObject({
  N: z
    .number()
    .int()
    .min(MIN_SCRYPT_N)
    .max(MAX_SCRYPT_N)
    .refine(isPowerOfTwo, 'N must be a power of two')
    .default(DEFAULT_SCRYPT.N),
  r: z.number().int().min(8).max(32).default(DEFAULT_SCRYPT.r),
  p: z.number().int().min(1).max(16).default(DEFAULT_SCRYPT.p),
});

export type ScryptParams = z.output<typeof ScryptParamsSchema>;

/** Configuration of the encrypted-file vault (`adapters.vault: encrypted-file`). */
export const EncryptedFileVaultConfigSchema = z.strictObject({
  /** Path of the vault file. Its directory is created (mode 0700) when it does not exist. */
  path: z.string().min(1),
  /** Cost of the key derivation, used when the file is created; an existing file keeps its own. */
  scrypt: ScryptParamsSchema.prefault({}),
});

/** What the user writes (defaults optional). */
export type EncryptedFileVaultConfigInput = z.input<typeof EncryptedFileVaultConfigSchema>;
/** What the adapter receives after validation. */
export type EncryptedFileVaultConfig = z.output<typeof EncryptedFileVaultConfigSchema>;
