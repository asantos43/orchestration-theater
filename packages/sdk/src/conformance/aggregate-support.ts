// SPDX-License-Identifier: MPL-2.0
import type { Clock, Store } from '@otheater/core';
import { expect } from 'vitest';
import type { Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

/** What the suites of the Phase 3 aggregates need from an adapter. */
export interface AggregateHarness extends Disposable {
  readonly store: Store;
  /** The clock the adapter stamps records with (or one reading the same time source). */
  readonly clock: Pick<Clock, 'now'> & {
    /** Moves the clock forward; the suites that need time to pass (the bindings) require it. */
    readonly advance?: (ms: number) => void | Promise<void>;
  };
}

/** Moves the clock of `harness` forward by `ms`; the adapter's test clock must offer `advance`. */
export async function advanceClock(harness: AggregateHarness, ms: number): Promise<void> {
  const { clock } = harness;
  if (clock.advance === undefined) {
    throw new TypeError('This suite needs a clock with advance(ms) (a FakeClock or the like)');
  }
  await clock.advance(ms);
}

/** Awaits a promise that must reject with the typed error `code`. */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  expect(await rejectionOf(promise)).toMatchObject({ code });
}
