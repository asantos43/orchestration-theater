// SPDX-License-Identifier: MPL-2.0
/**
 * Fakes for tests, exported as `@otheater/core/testing`. Kept out of the main entry point so
 * production code does not pull them in: only tests and the conformance suites import this.
 */
export * from './fake-clock.js';
export * from './in-memory-attempt-registry.js';
export * from './in-memory-event-log.js';
export * from './in-memory-secret-vault.js';
export * from './in-memory-store.js';
export * from './in-memory-tables.js';
export * from './fake-process-launcher.js';
export * from './fake-session-transport.js';
export * from './fake-client-adapter.js';
