// SPDX-License-Identifier: MPL-2.0

/** Awaits a promise that must reject and returns the rejection; fails the test if it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

/** A promise settled from the outside, to hold a test body at a known point. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Lets already-queued promise continuations run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
}

/**
 * Switches of the suites that can talk to a real client (Claude Code, Codex, OpenCode). Both are
 * off unless the environment says `1`, so a plain test run never starts a real client:
 * - `OT_TEST_REAL_CLIENTS=1` lets a suite registered with `{ real: true }` run at all;
 * - `OT_TEST_REAL_PROMPTS=1` also lets it send prompts, which spend quota of a real account.
 */
export function realClientFlags(): { readonly clients: boolean; readonly prompts: boolean } {
  return {
    clients: process.env.OT_TEST_REAL_CLIENTS === '1',
    prompts: process.env.OT_TEST_REAL_PROMPTS === '1',
  };
}

/** Options shared by the suites of the client layer. */
export interface ClientConformanceOptions {
  /**
   * The factory starts a real client. The suite then runs only with `OT_TEST_REAL_CLIENTS=1`, and
   * the tests that send a prompt only with `OT_TEST_REAL_PROMPTS=1` as well.
   */
  readonly real?: boolean;
}
