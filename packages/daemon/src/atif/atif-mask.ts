// SPDX-License-Identifier: MPL-2.0
import type { SecretVault } from '@otheater/core';
import { REDACTED_VALUE } from '@otheater/protocol';
import { maskSecrets } from '../execution/continuation-package.js';
import type { Masker } from './atif-builder.js';

/**
 * What keeps a secret out of a trajectory file (Phase 8, P5; architecture 5.11). [proposta] Two
 * nets, both always on, in every `atif.export.content` mode: the exact values the vault holds
 * (replaced wherever they appear), then the shapes of keys and tokens and the `NAME=value` of a
 * name that says secret (`maskSecrets`, the same net of the continuation package).
 */

/** A value shorter than this is not replaced: it would cut ordinary words out of the text. */
export const MIN_SECRET_LENGTH = 4;

export function createMasker(secretValues: readonly string[]): Masker {
  const values = [...new Set(secretValues)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join(REDACTED_VALUE);
    return maskSecrets(out);
  };
}

/** The plain values of the vault. Rejects when the vault cannot be read (a locked one). */
export async function vaultValues(vault: SecretVault): Promise<string[]> {
  const values: string[] = [];
  for (const key of await vault.list()) {
    const secret = await vault.get(key);
    if (secret !== undefined) values.push(secret.reveal());
  }
  return values;
}
