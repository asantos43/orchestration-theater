// SPDX-License-Identifier: MPL-2.0
import type { SqliteDriverName } from '@otheater/adapter-store-sqlite';

export const DRIVERS: readonly SqliteDriverName[] = ['better-sqlite3', 'node-sqlite'];

/** Progress goes to stderr; stdout is for the final tables. */
export type Log = (message: string) => void;

/** The `Clock` the store needs, without depending on the clock adapter. */
export const systemClock = { now: (): number => Date.now() };

/** Replaces every given private string (folders, home) in text that goes into the report. */
export function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 1) result = result.split(secret).join('<dir>');
  }
  return result;
}

/** Time budget shared by the scenarios. */
export class Deadline {
  readonly #endsAt: number;
  constructor(minutes: number, now: number = performance.now()) {
    this.#endsAt = now + minutes * 60_000;
  }
  get expired(): boolean {
    return performance.now() >= this.#endsAt;
  }
}
