// SPDX-License-Identifier: MPL-2.0
/**
 * Conformance suites of the `@otheater/core` ports (architecture 5.18, rule 5). Each is a function
 * that registers Vitest tests: an adapter author calls it from a test file with a factory that
 * builds a fresh instance of the adapter, and the adapter passes when the file passes.
 *
 * ```ts
 * import { describeClockConformance } from '@otheater/sdk';
 * describeClockConformance('my-clock', () => ({ clock: new MyClock(), advance: wait }));
 * ```
 */
export { type AdapterFactory, type Disposable } from './harness.js';
export { describeClockConformance, type ClockHarness } from './conformance/clock.js';
export {
  describeEventLogConformance,
  sampleEvent,
  type EventLogHarness,
} from './conformance/event-log.js';
export { describeStoreConformance, type StoreHarness } from './conformance/store.js';
export {
  describeSecretVaultConformance,
  type SecretVaultHarness,
} from './conformance/secret-vault.js';
// Vcs
export { describeVcsConformance, testGit, type VcsHarness } from './conformance/vcs.js';
