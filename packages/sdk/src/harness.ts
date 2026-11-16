// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach } from 'vitest';

/**
 * What an adapter author hands to a conformance suite: a function that builds a fresh, isolated
 * instance for each test (an empty store, a new temp-dir database, ...). It may be async.
 */
export type AdapterFactory<H> = () => H | Promise<H>;

/** Every harness may carry a `dispose` that the suite calls after each test. */
export interface Disposable {
  dispose?: () => Promise<void>;
}

/**
 * Builds a fresh harness before each test and disposes it after. Returns the accessor the tests
 * use, so a test that runs outside a hook fails loudly instead of using a stale instance.
 */
export function useHarness<H extends Disposable>(factory: AdapterFactory<H>): () => H {
  let current: H | undefined;
  beforeEach(async () => {
    current = await factory();
  });
  afterEach(async () => {
    const used = current;
    current = undefined;
    await used?.dispose?.();
  });
  return () => {
    if (current === undefined) throw new Error('Conformance harness used outside a test');
    return current;
  };
}
