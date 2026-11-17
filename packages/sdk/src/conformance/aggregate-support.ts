// SPDX-License-Identifier: MPL-2.0
import type { Clock, Store } from '@otheater/core';
import { expect } from 'vitest';
import type { Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

/** What the suites of the Phase 3 aggregates need from an adapter. */
export interface AggregateHarness extends Disposable {
  readonly store: Store;
  /** The clock the adapter stamps records with (or one reading the same time source). */
  readonly clock: Pick<Clock, 'now'>;
}

/** Awaits a promise that must reject with the typed error `code`. */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  expect(await rejectionOf(promise)).toMatchObject({ code });
}
